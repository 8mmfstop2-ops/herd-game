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

// Admin: add question
app.post("/add-question", async (req, res) => {
  const { prompt } = req.body;
  if (!prompt || !prompt.trim()) {
    return res.status(400).json({ error: "Prompt required" });
  }
  const r = await pool.query(
    "INSERT INTO questions (prompt) VALUES ($1) RETURNING id, prompt",
    [prompt.trim()]
  );
  res.json({ success: true, question: r.rows[0] });
});

// Admin: list questions
app.get("/questions", async (_req, res) => {
  const r = await pool.query("SELECT id, prompt FROM questions ORDER BY id DESC");
  res.json(r.rows);
});

// --- Socket.IO game flow omitted for brevity (same as your version) ---

const PORT = process.env.PORT || 1000; // run on port 1000 if desired
server.listen(PORT, () =>
  console.log(`Herd Mentality Game running on port ${PORT}`)
);
