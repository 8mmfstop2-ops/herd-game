const express = require("express");
const http = require("http");
const path = require("path");
const session = require("express-session");
const pg = require("pg");
const pgSession = require("connect-pg-simple")(session);
const { Server } = require("socket.io");
const bodyParser = require("body-parser");

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "game-admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Rainbow6GoldenEye";
const SESSION_SECRET = process.env.SESSION_SECRET || "change-this";
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = process.env.PORT || 3000;

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ✅ Use Postgres-backed session store
app.use(
  session({
    store: new pgSession({
      pool: pool,
      tableName: "session"
    }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 } // 30 days
  })
);

app.use(express.static(path.join(__dirname, "public")));

// --- DB bootstrap ---
async function initDb() {
  const schema = `
    CREATE TABLE IF NOT EXISTS rooms (
      id SERIAL PRIMARY KEY,
      code VARCHAR(16) UNIQUE NOT NULL,
      status VARCHAR(8) NOT NULL DEFAULT 'open',
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS questions (
      id SERIAL PRIMARY KEY,
      text TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS players (
      id SERIAL PRIMARY KEY,
      room_code VARCHAR(16) NOT NULL,
      name VARCHAR(64) NOT NULL,
      joined_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS rounds (
      id SERIAL PRIMARY KEY,
      room_code VARCHAR(16) NOT NULL,
      question_id INT NOT NULL,
      round_number INT NOT NULL,
      started_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS submissions (
      id SERIAL PRIMARY KEY,
      round_id INT NOT NULL,
      player_name VARCHAR(64) NOT NULL,
      answer TEXT NOT NULL,
      submitted_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `;
  await pool.query(schema);
  console.log("✅ Database tables ensured.");
}

// --- Auth guard ---
function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({ error: "Unauthorized" });
}

// --- Admin routes ---
app.get("/admin", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "admin-login.html"))
);
app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false });
});
app.get("/admin/dashboard", requireAdmin, (req, res) =>
  res.sendFile(path.join(__dirname, "public", "admin-dashboard.html"))
);
app.get("/admin/rooms", requireAdmin, (req, res) =>
  res.sendFile(path.join(__dirname, "public", "admin-rooms.html"))
);
app.get("/admin/cards", requireAdmin, (req, res) =>
  res.sendFile(path.join(__dirname, "public", "admin-cards.html"))
);

// --- Room APIs ---
app.post("/api/rooms", requireAdmin, async (req, res) => {
  const { code, status = "open" } = req.body;
  const result = await pool.query(
    "INSERT INTO rooms (code,status) VALUES ($1,$2) RETURNING *",
    [code, status]
  );
  res.json(result.rows[0]);
});
app.get("/api/rooms", requireAdmin, async (_req, res) => {
  const result = await pool.query("SELECT * FROM rooms ORDER BY created_at DESC");
  res.json(result.rows);
});
app.patch("/api/rooms/:code", requireAdmin, async (req, res) => {
  const { code } = req.params;
  const { status } = req.body;
  const result = await pool.query(
    "UPDATE rooms SET status=$1 WHERE code=$2 RETURNING *",
    [status, code]
  );
  res.json(result.rows[0]);
});

// --- Cards APIs ---
app.get("/api/questions", requireAdmin, async (_req, res) => {
  const result = await pool.query("SELECT * FROM questions ORDER BY id ASC");
  res.json(result.rows);
});
app.post("/api/questions", requireAdmin, async (req, res) => {
  const { text } = req.body;
  const result = await pool.query(
    "INSERT INTO questions (text) VALUES ($1) RETURNING *",
    [text]
  );
  res.json(result.rows[0]);
});

// --- Player join page ---
app.get("/player", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "player-page.html"))
);

// --- Player join API with DB check ---
app.post("/api/player/join", async (req, res) => {
  const { name, roomCode } = req.body;
  const room = await pool.query("SELECT * FROM rooms WHERE code=$1", [roomCode]);
  if (!room.rowCount) return res.status(404).json({ error: "Room not found" });
  if (room.rows[0].status !== "open") return res.status(400).json({ error: "Room closed" });
  await pool.query("INSERT INTO players (room_code,name) VALUES ($1,$2)", [roomCode, name]);
  res.json({ ok: true });
});

// --- Socket.IO ---
io.on("connection", (socket) => {
  socket.on("joinLobby", async ({ roomCode, name }) => {
    socket.join(roomCode);
    await pool.query(
      "INSERT INTO players (room_code,name) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [roomCode, name]
    );
    const players = await pool.query("SELECT name FROM players WHERE room_code=$1", [roomCode]);
    io.to(roomCode).emit("playerList", players.rows.map((p) => p.name));
  });

  socket.on("startRound", async ({ roomCode }) => {
    const roundCountRes = await pool.query(
      "SELECT COALESCE(MAX(round_number),0) AS max FROM rounds WHERE room_code=$1",
      [roomCode]
    );
    const nextRoundNumber = roundCountRes.rows[0].max + 1;

    const qRes = await pool.query(
      "SELECT id,text FROM questions ORDER BY id ASC LIMIT 1 OFFSET $1",
      [nextRoundNumber - 1]
    );
    if (!qRes.rowCount) {
      io.to(roomCode).emit("errorMsg", "No more questions available");
      return;
    }
    const question = qRes.rows[0];

    const roundRes = await pool.query(
      "INSERT INTO rounds (room_code,question_id,round_number) VALUES ($1,$2,$3) RETURNING id",
      [roomCode, question.id, nextRoundNumber]
    );
    const roundId = roundRes.rows[0].id;

    const players = await pool.query("SELECT COUNT(*)::int AS c FROM players WHERE room_code=$1", [roomCode]);

    io.to(roomCode).emit("roundStarted", {
      questionId: roundId,
      prompt: question.text,
      playerCount: players.rows[0].c,
      roundNumber: nextRoundNumber,
    });
  });

  socket.on("submitAnswer", async ({ roomCode, name, questionId, answer }) => {
    await pool.query(
      "INSERT INTO submissions (round_id,player_name,answer) VALUES ($1,$2,$3)",
      [questionId, name, answer]
    );

    const subs = await pool.query(
      "SELECT COUNT(*)::int AS c FROM submissions WHERE round_id=$1",
      [questionId]
    );
    const players = await pool.query(
      "SELECT COUNT(*)::int AS c FROM players WHERE room_code=$1",
      [roomCode]
    );

    io.to(roomCode).emit("submissionProgress", {
      submittedCount: subs.rows[0].c,
      totalPlayers: players.rows[0].c,
    });

    if (subs.rows[0].c >= players.rows[0].c) {
      io.to(roomCode).emit("allSubmitted");
    }
  });

  socket.on("showAnswers", async ({ roomCode }) => {
    const latestRound = await pool.query(
      "SELECT id FROM rounds WHERE room_code=$1 ORDER BY round_number DESC LIMIT 1",
      [roomCode]
    );
    if (!latestRound.rowCount) return;
    const roundId = latestRound.rows[0].id;

    const subs = await pool.query(
      "SELECT player_name AS name, answer FROM submissions WHERE round_id=$1 ORDER BY submitted_at ASC",
      [roundId]
    );
    io.to(roomCode).emit("answersRevealed", subs.rows);
  });

  socket.on("nextRound", ({ roomCode }) => {
    io.to(roomCode).emit("readyForNextRound");
  });
});

initDb().then(() => {
  server.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));
});

	
	
	
	