// server.js
const express = require("express");
const http = require("http");
const path = require("path");
const bodyParser = require("body-parser");
const { Pool } = require("pg");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Initialize tables
(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rooms (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE,
      status TEXT DEFAULT 'open'
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      room_code TEXT REFERENCES rooms(code) ON DELETE CASCADE
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS questions (
      id SERIAL PRIMARY KEY,
      prompt TEXT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS answers (
      id SERIAL PRIMARY KEY,
      room_code TEXT NOT NULL,
      player_name TEXT NOT NULL,
      question_id INT NOT NULL,
      round_number INT NOT NULL,
      answer TEXT NOT NULL
    );
  `);
})();

// Admin login
app.post("/admin-login", (req, res) => {
  const { username, password } = req.body;
  if (username === "game-admin" && password === "Rainbow6GoldenEye") {
    res.json({ success: true });
  } else {
    res.status(401).json({ error: "Invalid credentials" });
  }
});

// Admin: create room
app.post("/create-room", async (req, res) => {
  const { code } = req.body;
  try {
    await pool.query("INSERT INTO rooms (code, status) VALUES ($1, 'open')", [code]);
    res.json({ success: true, roomCode: code });
  } catch (e) {
    res.status(400).json({ error: "Room already exists" });
  }
});

// Admin: update room status
app.post("/update-room-status", async (req, res) => {
  const { code, status } = req.body;
  if (!["open", "closed"].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }
  const r = await pool.query("UPDATE rooms SET status=$1 WHERE code=$2 RETURNING code,status", [status, code]);
  if (r.rowCount === 0) return res.status(404).json({ error: "Room not found" });
  res.json({ success: true, roomCode: r.rows[0].code, newStatus: r.rows[0].status });
});

// Admin: add question
app.post("/add-question", async (req, res) => {
  const { prompt } = req.body;
  if (!prompt || !prompt.trim()) return res.status(400).json({ error: "Prompt required" });
  const r = await pool.query("INSERT INTO questions (prompt) VALUES ($1) RETURNING id, prompt", [prompt.trim()]);
  res.json({ success: true, question: r.rows[0] });
});

// Admin: list questions
app.get("/questions", async (_req, res) => {
  const r = await pool.query("SELECT id, prompt FROM questions ORDER BY id DESC");
  res.json(r.rows);
});

// Player: join room (rejoin supported)
app.post("/join-room", async (req, res) => {
  const { name, roomCode } = req.body;
  const room = await pool.query("SELECT * FROM rooms WHERE code=$1", [roomCode]);
  if (room.rows.length === 0) return res.status(404).json({ error: "Room not found" });
  if (room.rows[0].status === "closed") return res.status(403).json({ error: "Room is closed" });

  const existing = await pool.query("SELECT id FROM players WHERE name=$1 AND room_code=$2", [name, roomCode]);
  if (existing.rows.length === 0) {
    await pool.query("INSERT INTO players (name, room_code) VALUES ($1,$2)", [name, roomCode]);
  }

  res.json({ success: true, lobbyUrl: `/lobby.html?room=${roomCode}&name=${encodeURIComponent(name)}` });
});

// In-memory per-room state for live game flow
// roomCode -> {
//   sockets: Map(socketId -> playerName),
//   order: number[] (question IDs shuffled for the room),
//   idx: number (current position in order),
//   roundNumber: number,
//   submitted: Set(playerName),
//   playerCount: number,
//   activeQuestionId: number | null,
//   activePrompt: string | null
// }
const stateByRoom = new Map();

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

io.on("connection", (socket) => {
  // Player joins lobby presence
  socket.on("joinLobby", async ({ roomCode, name }) => {
    socket.join(roomCode);

    if (!stateByRoom.has(roomCode)) {
      stateByRoom.set(roomCode, {
        sockets: new Map(),
        order: [],
        idx: 0,
        roundNumber: 0,
        submitted: new Set(),
        playerCount: 0,
        activeQuestionId: null,
        activePrompt: null
      });
    }
    const roomState = stateByRoom.get(roomCode);
    roomState.sockets.set(socket.id, name);

    // Broadcast current player list
    const names = Array.from(roomState.sockets.values());
    io.to(roomCode).emit("playerList", names);
  });

  // Start game or next round: build or continue shuffled question order
  socket.on("startRound", async ({ roomCode }) => {
    const roomState = stateByRoom.get(roomCode);
    if (!roomState) return;

    // Build question order if empty
    if (roomState.order.length === 0) {
      const qr = await pool.query("SELECT id FROM questions");
      const ids = qr.rows.map(r => r.id);
      if (ids.length === 0) {
        io.to(roomCode).emit("errorMsg", "No questions available. Admin must add questions.");
        return;
      }
      roomState.order = shuffle(ids.slice());
      roomState.idx = 0;
      roomState.roundNumber = 0;
    }

    // Pick next question
    if (roomState.idx >= roomState.order.length) {
      // reshuffle if exhausted
      roomState.order = shuffle(roomState.order);
      roomState.idx = 0;
      roomState.roundNumber = 0;
    }

    const qid = roomState.order[roomState.idx];
    const q = await pool.query("SELECT prompt FROM questions WHERE id=$1", [qid]);
    const prompt = q.rows[0].prompt;

    roomState.activeQuestionId = qid;
    roomState.activePrompt = prompt;
    roomState.submitted.clear();
    roomState.playerCount = roomState.sockets.size;
    roomState.roundNumber += 1;

    io.to(roomCode).emit("roundStarted", {
      questionId: qid,
      prompt,
      playerCount: roomState.playerCount,
      roundNumber: roomState.roundNumber
    });
  });

  // Player submits answer
  socket.on("submitAnswer", async ({ roomCode, name, questionId, answer }) => {
    const roomState = stateByRoom.get(roomCode);
    if (!roomState || roomState.activeQuestionId !== questionId) return;

    await pool.query(`
      INSERT INTO answers (room_code, player_name, question_id, round_number, answer)
      VALUES ($1,$2,$3,$4,$5)
    `, [roomCode, name, questionId, roomState.roundNumber, answer]);

    roomState.submitted.add(name);

    io.to(roomCode).emit("submissionProgress", {
      submittedCount: roomState.submitted.size,
      totalPlayers: roomState.playerCount
    });

    if (roomState.submitted.size === roomState.playerCount) {
      io.to(roomCode).emit("allSubmitted");
    }
  });

  // Admin or any player reveals answers
  socket.on("showAnswers", async ({ roomCode }) => {
    const roomState = stateByRoom.get(roomCode);
    if (!roomState || !roomState.activeQuestionId) return;

    const qid = roomState.activeQuestionId;
    const rr = await pool.query(`
      SELECT player_name AS name, answer
      FROM answers
      WHERE room_code=$1 AND question_id=$2 AND round_number=$3
      ORDER BY name ASC
    `, [roomCode, qid, roomState.roundNumber]);

    io.to(roomCode).emit("answersRevealed", rr.rows);
  });

  // Advance to next question (optional)
  socket.on("nextRound", ({ roomCode }) => {
    const roomState = stateByRoom.get(roomCode);
    if (!roomState) return;
    roomState.idx += 1;
    io.to(roomCode).emit("readyForNextRound");
  });

  // Disconnect cleanup
  socket.on("disconnect", () => {
    for (const [roomCode, roomState] of stateByRoom.entries()) {
      if (roomState.sockets.has(socket.id)) {
        roomState.sockets.delete(socket.id);
        const names = Array.from(roomState.sockets.values());
        io.to(roomCode).emit("playerList", names);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Herd Mentality Game running on port ${PORT}`));
