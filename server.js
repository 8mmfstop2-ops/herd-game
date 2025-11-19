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
      score INT NOT NULL DEFAULT 0,
      has_cow BOOLEAN NOT NULL DEFAULT FALSE,
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

// In-memory state
const stateByRoom = new Map();
function shuffle(arr){for(let i=arr.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[arr[i],arr[j]]=[arr[j],arr[i]];}return arr;}

io.on("connection", (socket) => {
  socket.on("joinLobby", async ({ roomCode, name }) => {
    const rc = roomCode.toUpperCase();
    socket.join(rc);
    if (!stateByRoom.has(rc)) {
      stateByRoom.set(rc,{sockets:new Map(),order:[],idx:-1,roundNumber:0,submitted:new Set(),playerCount:0,activeQuestionId:null});
    }
    const st=stateByRoom.get(rc);
    st.sockets.set(socket.id,name);

    // Ensure player exists in DB
    await pool.query(`
      INSERT INTO players (name, room_code, score, has_cow)
      VALUES ($1,$2,0,false)
      ON CONFLICT (name, room_code) DO NOTHING
    `,[name,rc]);

    const players = await pool.query("SELECT name, score, has_cow FROM players WHERE room_code=$1 ORDER BY name ASC",[rc]);
    io.to(rc).emit("playerList", players.rows);
  });

  // Update score
  socket.on("updateScore", async ({ roomCode, name, score }) => {
    const rc=roomCode.toUpperCase();
    await pool.query("UPDATE players SET score=$1 WHERE room_code=$2 AND name=$3",[score,rc,name]);
    const players = await pool.query("SELECT name, score, has_cow FROM players WHERE room_code=$1 ORDER BY name ASC",[rc]);
    io.to(rc).emit("playerList", players.rows);
  });

  // Update cow holder (only one true per room)
  socket.on("updateCow", async ({ roomCode, name }) => {
    const rc=roomCode.toUpperCase();
    await pool.query("UPDATE players SET has_cow=false WHERE room_code=$1",[rc]);
    await pool.query("UPDATE players SET has_cow=true WHERE room_code=$1 AND name=$2",[rc,name]);
    const players = await pool.query("SELECT name, score, has_cow FROM players WHERE room_code=$1 ORDER BY name ASC",[rc]);
    io.to(rc).emit("playerList", players.rows);
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

  socket.on("disconnect",()=>{for(const [rc,st] of stateByRoom.entries()){if(st.sockets.has(socket.id)){st.sockets.delete(socket.id);pool.query("SELECT name, score, has_cow FROM players WHERE room_code=$1 ORDER BY name ASC",[rc]).then(r=>io.to(rc).emit("playerList",r.rows));if(st.sockets.size===0)stateByRoom.delete(rc);}}});
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log("Herd Mentality Game running on port " + PORT));
