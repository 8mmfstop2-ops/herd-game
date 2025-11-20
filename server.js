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
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(name, room_code)
    );
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

// Admin login (simple env var check)
app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body;
  const ADMIN_USER = process.env.ADMIN_USER || "game-admin";
  const ADMIN_PASS = process.env.ADMIN_PASS || "Rainbow6GoldenEye";
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    return res.json({ success: true });
  }
  res.status(401).json({ error: "Invalid credentials" });
});

// Player join
app.post("/api/player/join", async (req, res) => {
  const { name, roomCode } = req.body;
  const rc = roomCode.toUpperCase();
  const room = await pool.query("SELECT * FROM rooms WHERE code=$1", [rc]);
  if (room.rows.length === 0) return res.status(404).json({ error: "Room not found" });
  if (room.rows[0].status === "closed") return res.status(403).json({ error: "Room closed" });

  await pool.query(
    "INSERT INTO players (name, room_code) VALUES ($1,$2) ON CONFLICT (name, room_code) DO NOTHING",
    [name, rc]
  );
  res.json({ success: true, redirect: `/player-board.html?room=${rc}&name=${encodeURIComponent(name)}` });
});

// Socket.IO game logic
io.on("connection", (socket) => {
  socket.on("joinLobby", async ({ roomCode, name }) => {
    const rc = roomCode.toUpperCase();
    socket.join(rc);

    // Ensure player exists
    await pool.query(
      "INSERT INTO players (name, room_code) VALUES ($1,$2) ON CONFLICT (name, room_code) DO NOTHING",
      [name, rc]
    );

    // Send current player list
    const players = await pool.query("SELECT name, submitted FROM players WHERE room_code=$1 ORDER BY name ASC", [rc]);
    io.to(rc).emit("playerList", players.rows);

    // Restore state if round is active
    const room = await pool.query("SELECT current_round, active_question_id FROM rooms WHERE code=$1", [rc]);
    if (room.rows.length && room.rows[0].active_question_id) {
      const q = await pool.query("SELECT prompt FROM questions WHERE id=$1", [room.rows[0].active_question_id]);
      socket.emit("roundStarted", {
        questionId: room.rows[0].active_question_id,
        prompt: q.rows[0].prompt,
        playerCount: players.rows.length,
        roundNumber: room.rows[0].current_round
      });
    }
  });

  socket.on("startRound", async ({ roomCode }) => {
    const rc = roomCode.toUpperCase();

    // Pick next question
    const qr = await pool.query("SELECT id FROM questions ORDER BY sort_number ASC");
    if (qr.rows.length === 0) return;
    const qid = qr.rows[Math.floor(Math.random() * qr.rows.length)].id;
    const q = await pool.query("SELECT prompt FROM questions WHERE id=$1", [qid]);

    // Update room state
    await pool.query("UPDATE rooms SET current_round = current_round+1, active_question_id=$1 WHERE code=$2", [qid, rc]);

    // Reset submissions
    await pool.query("UPDATE players SET submitted=false WHERE room_code=$1", [rc]);

    const players = await pool.query("SELECT name, submitted FROM players WHERE room_code=$1 ORDER BY name ASC", [rc]);
    io.to(rc).emit("playerList", players.rows);

    io.to(rc).emit("roundStarted", {
      questionId: qid,
      prompt: q.rows[0].prompt,
      playerCount: players.rows.length,
      roundNumber: (await pool.query("SELECT current_round FROM rooms WHERE code=$1", [rc])).rows[0].current_round
    });
  });

  socket.on("submitAnswer", async ({ roomCode, name, questionId, answer }) => {
    const rc = roomCode.toUpperCase();
    const room = await pool.query("SELECT current_round, active_question_id FROM rooms WHERE code=$1", [rc]);
    if (!room.rows.length || room.rows[0].active_question_id !== questionId) return;

    await pool.query(
      "INSERT INTO answers (room_code, player_name, question_id, round_number, answer) VALUES ($1,$2,$3,$4,$5)",
      [rc, name, questionId, room.rows[0].current_round, answer]
    );
    await pool.query("UPDATE players SET submitted=true WHERE room_code=$1 AND name=$2", [rc, name]);

    const players = await pool.query("SELECT name, submitted FROM players WHERE room_code=$1 ORDER BY name ASC", [rc]);
    io.to(rc).emit("playerList", players.rows);

    const submittedCount = players.rows.filter(p => p.submitted).length;
    io.to(rc).emit("submissionProgress", { submittedCount, totalPlayers: players.rows.length });

    if (submittedCount === players.rows.length) {
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
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log("Herd Mentality Game running on port " + PORT));
