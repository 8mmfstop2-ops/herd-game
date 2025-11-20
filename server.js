// v1.0.2

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

// ---------------- Helpers ----------------
function getActiveNames(roomCode) {
  const connected = io.sockets.adapter.rooms.get(roomCode) || new Set();
  const activeNames = [];
  for (const socketId of connected) {
    const s = io.sockets.sockets.get(socketId);
    if (s && s.data && s.data.name) {
      activeNames.push(s.data.name);
    }
  }
  return activeNames;
}

async function getActiveStats(roomCode) {
  const dbPlayers = await pool.query(
    "SELECT name, submitted FROM players WHERE room_code=$1 ORDER BY name ASC",
    [roomCode]
  );
  const activeNames = getActiveNames(roomCode);
  const merged = dbPlayers.rows.map(p => ({
    name: p.name,
    submitted: p.submitted,
    active: activeNames.includes(p.name)
  }));
  const activeCount = merged.filter(p => p.active).length;
  const submittedActiveCount = merged.filter(p => p.active && p.submitted).length;
  return { merged, activeCount, submittedActiveCount };
}

async function emitPlayerList(roomCode) {
  const { merged, activeCount, submittedActiveCount } = await getActiveStats(roomCode);
  io.to(roomCode).emit("playerList", {
    players: merged,
    activeCount,
    submittedCount: submittedActiveCount
  });
}

// ---------------- Socket.IO Game Logic ----------------
io.on("connection", (socket) => {
  socket.on("joinLobby", async ({ roomCode, name }) => {
    const rc = roomCode.toUpperCase();
    socket.data.name = name;
    socket.data.roomCode = rc;
    socket.join(rc);

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
      const { activeCount, submittedActiveCount } = await getActiveStats(rc);

      socket.emit("roundStarted", {
        questionId: room.rows[0].active_question_id,
        prompt: q.rows[0].prompt,
        playerCount: activeCount,
        roundNumber: room.rows[0].current_round,
        myAnswer: ans.rows.length ? ans.rows[0].answer : null
      });

      // 👇 Broadcast current submission progress to everyone
      io.to(rc).emit("submissionProgress", {
        submittedCount: submittedActiveCount,
        totalPlayers: activeCount
      });

      if (activeCount > 0 && submittedActiveCount === activeCount) {
        io.to(rc).emit("allSubmitted");
      }
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
    const { activeCount } = await getActiveStats(rc);
    io.to(rc).emit("roundStarted", {
      questionId: qid,
      prompt: q.rows[0].prompt,
      playerCount: activeCount,
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

    const { activeCount, submittedActiveCount } = await getActiveStats(rc);
    io.to(rc).emit("submissionProgress", {
      submittedCount: submittedActiveCount,
      totalPlayers: activeCount
    });

    if (activeCount > 0 && submittedActiveCount === activeCount) {
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

  socket.on("disconnect", async () => {
    const r = socket.data?.roomCode;
    if (r) {
      await emitPlayerList(r);
    }
  });
});

// ---------------- Start Server ----------------
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log("Herd Mentality Game running on port " + PORT));
