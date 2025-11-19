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

// In-memory state
const stateByRoom = new Map();
function shuffle(arr){for(let i=arr.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[arr[i],arr[j]]=[arr[j],arr[i]];}return arr;}

io.on("connection", (socket) => {
  socket.on("joinLobby", ({ roomCode, name }) => {
    const rc = roomCode.toUpperCase();
    socket.join(rc);

    if (!stateByRoom.has(rc)) {
      stateByRoom.set(rc, {
        sockets:new Map(),
        order:[],
        idx:-1,
        roundNumber:0,
        submitted:new Set(),
        playerCount:0,
        activeQuestionId:null
      });
    }
    const st = stateByRoom.get(rc);
    st.sockets.set(socket.id, name);

    // Update player list
    io.to(rc).emit("playerList", Array.from(st.sockets.values()));

    // 🔥 If a round is active, send current round state to reconnecting player
    if (st.activeQuestionId) {
      (async () => {
        const q = await pool.query("SELECT prompt FROM questions WHERE id=$1", [st.activeQuestionId]);
        socket.emit("roundStarted", {
          questionId: st.activeQuestionId,
          prompt: q.rows[0].prompt,
          playerCount: st.playerCount,
          roundNumber: st.roundNumber
        });

        socket.emit("submissionProgress", {
          submittedCount: st.submitted.size,
          totalPlayers: st.playerCount
        });

        if (st.submitted.size === st.playerCount) {
          socket.emit("allSubmitted");
        }
      })();
    }
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

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log("Herd Mentality Game running on port " + PORT));
