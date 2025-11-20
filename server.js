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

// ---------------- Initialize tables ----------------
(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rooms (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      current_round INT DEFAULT 0,
      active_question_id INT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      room_code TEXT REFERENCES rooms(code) ON DELETE CASCADE,
      submitted BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS players_name_room_unique
    ON players (LOWER(name), room_code);
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS questions (
      id SERIAL PRIMARY KEY,
      prompt TEXT NOT NULL,
      sort_number INT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS answers (
      id SERIAL PRIMARY KEY,
      room_code TEXT NOT NULL,
      player_name TEXT NOT NULL,
      question_id INT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
      round_number INT NOT NULL,
      answer TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);
})();

// ---------------- Admin Login API ----------------
app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body;
  const ADMIN_USER = process.env.ADMIN_USER || "game-admin";
  const ADMIN_PASS = process.env.ADMIN_PASS || "Rainbow6GoldenEye";
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    return res.json({ success: true });
  }
  res.status(401).json({ error: "Invalid credentials" });
});

// ---------------- Room Management APIs ----------------
app.get("/api/rooms", async (_req, res) => {
  const r = await pool.query("SELECT code, status, created_at FROM rooms ORDER BY id DESC");
  res.json(r.rows);
});

app.post("/api/player/join", async (req, res) => {
  const { name, roomCode } = req.body;
  const rc = roomCode.toUpperCase();
  const room = await pool.query("SELECT * FROM rooms WHERE code=$1", [rc]);
  if (room.rows.length === 0) return res.status(404).json({ error: "Room not found" });
  if (room.rows[0].status === "closed") return res.status(403).json({ error: "Room closed" });

  // handle mix case names part 1
  await pool.query(
    "INSERT INTO players (name, room_code) VALUES ($1,$2) ON CONFLICT (LOWER(name), room_code) DO NOTHING",
    [name, rc]
  );

  res.json({ success: true, redirect: `/player-board.html?room=${rc}&name=${encodeURIComponent(name)}` });
});


app.patch("/api/rooms/:code", async (req, res) => {
  const { status } = req.body;
  const code = req.params.code.toUpperCase();
  const r = await pool.query("UPDATE rooms SET status=$1 WHERE code=$2 RETURNING code,status", [status, code]);
  if (r.rowCount === 0) return res.status(404).json({ error: "Room not found" });
  res.json(r.rows[0]);
});

// ---------------- Question Management APIs ----------------
app.get("/api/questions", async (_req, res) => {
  const r = await pool.query("SELECT id, prompt, sort_number FROM questions ORDER BY id DESC");
  res.json(r.rows);
});
app.post("/api/questions", async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "Prompt required" });
  const r = await pool.query(
    "INSERT INTO questions (prompt) VALUES ($1) RETURNING id, prompt",
    [text.trim()]
  );
  const newId = r.rows[0].id;
  await pool.query("UPDATE questions SET sort_number = $1 WHERE id = $1", [newId]);
  res.json({ id: newId, prompt: r.rows[0].prompt, sort_number: newId });
});
app.put("/api/questions/:id", async (req, res) => {
  const { text } = req.body;
  const id = parseInt(req.params.id, 10);
  if (!text) return res.status(400).json({ error: "Prompt required" });
  const r = await pool.query(
    "UPDATE questions SET prompt=$1 WHERE id=$2 RETURNING id, prompt, sort_number",
    [text.trim(), id]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: "Question not found" });
  res.json(r.rows[0]);
});
app.delete("/api/questions/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await pool.query("DELETE FROM questions WHERE id=$1 RETURNING id", [id]);
  if (r.rowCount === 0) return res.status(404).json({ error: "Question not found" });
  res.json({ success: true });
});

// ---------------- Player Join API ----------------
app.post("/api/player/join", async (req, res) => {
  const { name, roomCode } = req.body;
  const rc = roomCode.toUpperCase();
  const room = await pool.query("SELECT * FROM rooms WHERE code=$1", [rc]);
  if (room.rows.length === 0) return res.status(404).json({ error: "Room not found" });
  if (room.rows[0].status === "closed") return res.status(403).json({ error: "Room closed" });

  await pool.query(
    "INSERT INTO players (name, room_code) VALUES ($1,$2) ON CONFLICT ON CONSTRAINT players_name_room_unique DO NOTHING",
    [name, rc]
  );
  res.json({ success: true, redirect: `/player-board.html?room=${rc}&name=${encodeURIComponent(name)}` });
});

// ---------------- Socket.IO Game Logic ----------------
io.on("connection", (socket) => {
  socket.on("joinLobby", async ({ roomCode, name }) => {
    const rc = roomCode.toUpperCase();
    socket.join(rc);

    // handle mixed case nmames part 2
    await pool.query(
      "INSERT INTO players (name, room_code) VALUES ($1,$2) ON CONFLICT (LOWER(name), room_code) DO NOTHING",
      [name, rc]
    );
    await emitPlayerList(rc);

    const room = await pool.query("SELECT current_round, active_question_id FROM rooms WHERE code=$1", [rc]);
    if (room.rows.length && room.rows[0].active_question_id) {
      const q = await pool.query("SELECT prompt FROM questions WHERE id=$1", [room.rows[0].active_question_id]);
      const ans = await pool.query(
        "SELECT answer FROM answers WHERE room_code=$1 AND LOWER(player_name)=LOWER($2) AND question_id=$3 AND round_number=$4",
        [rc, name, room.rows[0].active_question_id, room.rows[0].current_round]
      );
      socket.emit("roundStarted", {
        questionId: room.rows[0].active_question_id,
        prompt: q.rows[0].prompt,
        playerCount: (await pool.query("SELECT COUNT(*) FROM players WHERE room_code=$1", [rc])).rows[0].count,
        roundNumber: room.rows[0].current_round,
        myAnswer: ans.rows.length ? ans.rows[0].answer : null
      });
    }
  });

  socket.on("startRound", async ({ roomCode }) => {
    const rc = roomCode.toUpperCase();
    const qr = await pool.query("SELECT id FROM questions ORDER BY sort_number ASC");
    if (qr.rows.length === 0) return;
    const qid = qr.rows[Math.floor(Math.random() * qr.rows.length)].id;
    const q = await pool.query("SELECT prompt FROM questions WHERE id=$1", [qid]);

    await pool.query("UPDATE rooms SET current_round = current_round+1, active_question_id=$1 WHERE code=$2", [qid, rc]);
    await pool.query("UPDATE players SET submitted=false WHERE room_code=$1", [rc]);

    await emitPlayerList(rc);

    const roundNum = (await pool.query("SELECT current_round FROM rooms WHERE code=$1", [rc])).rows[0].current_round;
    io.to(rc).emit("roundStarted", {
      questionId: qid,
      prompt: q.rows[0].prompt,
      playerCount: (await pool.query("SELECT COUNT(*) FROM players WHERE room_code=$1", [rc])).rows[0].count,
      roundNumber: roundNum,
      myAnswer: null
    });
  });

  socket.on("submitAnswer", async ({ roomCode, name, questionId, answer }) => {
    const rc = roomCode.toUpperCase();
    const room = await pool.query("SELECT current_round, active_question_id FROM rooms WHERE code=$1", [rc]);
    if (!room.rows.length || room.rows[0].active_question_id !== questionId) return;

    await pool.query(
      "INSERT INTO answers (room_code, player_name, question_id, round_number, answer) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
      [rc, name, questionId, room.rows[0].current_round, answer]
    );
    await pool.query("UPDATE players SET submitted=true WHERE room_code=$1 AND LOWER(name)=LOWER($2)", [rc, name]);

    await emitPlayerList(rc);

    const submittedCount = (await pool.query("SELECT COUNT(*) FROM players WHERE room_code=$1 AND submitted=true", [rc])).rows[0].count;
    const totalPlayers = (await pool.query("SELECT COUNT(*) FROM players WHERE room_code=$1", [rc])).rows[0].count;
    io.to(rc).emit("submissionProgress", { submittedCount, totalPlayers });

    if (submittedCount == totalPlayers) {
      io.to(rc).emit("allSubmitted");
    }
  });

  socket.on("showAnswers", async ({ roomCode }) => {
    const rc = roomCode.toUpperCase();
    const room = await pool.query("SELECT current_round, active_question_id FROM rooms WHERE code=$1", [rc]);
    if (!room.rows.length || !room.rows[0].active_question_id) return;

    const rr = await pool.query(
      "SELECT player_name AS name, answer FROM answers WHERE room_code=$1 AND question_id=$2 AND round_number=$3 ORDER BY name ASC",
      [rc, room.rows[0].active_question_id, room.rows[0].current_round]
    );
    io.to(rc).emit("answersRevealed", rr.rows);
  });
}); // <-- closes io.on("connection")

// ---------------- Helper to emit full player list ----------------
async function emitPlayerList(roomCode) {
  const dbPlayers = await pool.query(
    "SELECT name, submitted FROM players WHERE room_code=$1 ORDER BY name ASC",
    [roomCode]
  );

  const connectedSockets = io.sockets.adapter.rooms.get(roomCode) || new Set();
  const activeNames = [];
  for (const socketId of connectedSockets) {
    const s = io.sockets.sockets.get(socketId);
    if (s && s.handshake && s.handshake.query && s.handshake.query.name) {
      activeNames.push(s.handshake.query.name);
    }
  }

  const merged = dbPlayers.rows.map(p => ({
    name: p.name,
    submitted: p.submitted,
    active: activeNames.includes(p.name)
  }));

  io.to(roomCode).emit("playerList", merged);
}

// ---------------- Start Server ----------------
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log("Herd Mentality Game running on port " + PORT));

