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
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      room_code TEXT REFERENCES rooms(code) ON DELETE CASCADE,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
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

// Admin login
app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body;
  const ADMIN_USER = process.env.ADMIN_USER || "game-admin";
  const ADMIN_PASS = process.env.ADMIN_PASS || "Rainbow6GoldenEye";
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    return res.json({ success: true });
  }
  res.status(401).json({ error: "Invalid credentials" });
});

// Rooms API
app.get("/api/rooms", async (_req, res) => {
  const r = await pool.query("SELECT code, status, created_at FROM rooms ORDER BY id DESC");
  res.json(r.rows);
});
app.post("/api/rooms", async (req, res) => {
  const { code, status } = req.body;
  if (!code) return res.status(400).json({ error: "Room code required" });
  try {
    await pool.query("INSERT INTO rooms (code, status) VALUES ($1,$2)", [code.toUpperCase(), status || "open"]);
    res.json({ success: true });
  } catch {
    res.status(400).json({ error: "Room already exists" });
  }
});
app.patch("/api/rooms/:code", async (req, res) => {
  const { status } = req.body;
  const code = req.params.code.toUpperCase();
  const r = await pool.query("UPDATE rooms SET status=$1 WHERE code=$2 RETURNING code,status", [status, code]);
  if (r.rowCount === 0) return res.status(404).json({ error: "Room not found" });
  res.json(r.rows[0]);
});

// Questions API
app.get("/api/questions", async (_req, res) => {
  const r = await pool.query("SELECT id, prompt, sort_number FROM questions ORDER BY id DESC");
  res.json(r.rows);
});
app.post("/api/questions", async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "Prompt required" });

  // Insert question
  const r = await pool.query(
    "INSERT INTO questions (prompt) VALUES ($1) RETURNING id, prompt",
    [text.trim()]
  );
  const newId = r.rows[0].id;

  // Update sort_number to match id
  await pool.query("UPDATE questions SET sort_number = $1 WHERE id = $1", [newId]);

  res.json({ id: newId, prompt: r.rows[0].prompt, sort_number: newId });
});

// Player join
app.post("/api/player/join", async (req, res) => {
  const { name, roomCode } = req.body;
  const rc = roomCode.toUpperCase();
  const room = await pool.query("SELECT * FROM rooms WHERE code=$1", [rc]);
  if (room.rows.length === 0) return res.status(404).json({ error: "Room not found" });
  if (room.rows[0].status === "closed") return res.status(403).json({ error: "Room closed" });
  const existing = await pool.query("SELECT id FROM players WHERE name=$1 AND room_code=$2", [name, rc]);
  if (existing.rows.length === 0) {
    await pool.query("INSERT INTO players (name, room_code) VALUES ($1,$2)", [name, rc]);
  }
  res.json({ success: true, redirect: `/player-board.html?room=${rc}&name=${encodeURIComponent(name)}` });
});

// In-memory state
const stateByRoom = new Map();
function shuffle(arr){for(let i=arr.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[arr[i],arr[j]]=[arr[j],arr[i]];}return arr;}

io.on("connection", (socket) => {
  socket.on("joinLobby", ({ roomCode, name }) => {
    const rc = roomCode.toUpperCase();
    socket.join(rc);
    if (!stateByRoom.has(rc)) {
      stateByRoom.set(rc,{sockets:new Map(),order:[],idx:-1,roundNumber:0,submitted:new Set(),playerCount:0,activeQuestionId:null});
    }
    const st=stateByRoom.get(rc);
    st.sockets.set(socket.id,name);
    io.to(rc).emit("playerList", Array.from(st.sockets.values()));
  });

  socket.on("startRound", async ({ roomCode }) => {
    const rc=roomCode.toUpperCase();
    const st=stateByRoom.get(rc);
    if (!st) return;
    if (st.order.length===0){const qr=await pool.query("SELECT id FROM questions");st.order=shuffle(qr.rows.map(r=>r.id));st.idx=-1;}
    st.idx++;
    if (st.idx>=st.order.length){st.order=shuffle(st.order);st.idx=0;}
    const qid=st.order[st.idx];
    const q=await pool.query("SELECT prompt FROM questions WHERE id=$1",[qid]);
    st.activeQuestionId=qid;
    st.submitted.clear();
    st.playerCount=st.sockets.size;
    st.roundNumber++;
    io.to(rc).emit("roundStarted",{questionId:qid,prompt:q.rows[0].prompt,playerCount:st.playerCount,roundNumber:st.roundNumber});
  });

  socket.on("submitAnswer", async ({ roomCode,name,questionId,answer }) => {
    const rc=roomCode.toUpperCase();
    const st=stateByRoom.get(rc);
    if (!st||st.activeQuestionId!==questionId) return;
    await pool.query("INSERT INTO answers (room_code,player_name,question_id,round_number,answer) VALUES ($1,$2,$3,$4,$5)",[rc,name,questionId,st.roundNumber,answer]);
    st.submitted.add(name);
    io.to(rc).emit("submissionProgress",{submittedCount:st.submitted.size,totalPlayers:st.playerCount});
    if (st.submitted.size===st.playerCount){io.to(rc).emit("allSubmitted");}
  });

  socket.on("showAnswers", async ({ roomCode }) => {
    const rc=roomCode.toUpperCase();
    const st=stateByRoom.get(rc);
    if (!st||!st.activeQuestionId) return;
    const rr=await pool.query("SELECT player_name AS name,answer FROM answers WHERE room_code=$1 AND question_id=$2 AND round_number=$3 ORDER BY name ASC",[rc,st.activeQuestionId,st.roundNumber]);
    io.to(rc).emit("answersRevealed",rr.rows);
  });

  socket.on("disconnect",()=>{for(const [rc,st] of stateByRoom.entries()){if(st.sockets.has(socket.id)){st.sockets.delete(socket.id);io.to(rc).emit("playerList",Array.from(st.sockets.values()));if(st.sockets.size===0)stateByRoom.delete(rc);}}});
});

// ✅ Port safe for local and Render
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log("Herd Mentality Game running on port " + PORT));
