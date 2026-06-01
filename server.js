import express from 'express';
import Database from 'better-sqlite3';

const app = express();
const db = new Database('game.db');

// Enable JSON reading so the server understands data sent from your Roblox game
app.use(express.json());

// ─── DATABASE AUTO-INITIALIZATION ────────────────────────────────────
// These commands build your local database tables instantly if they don't exist yet.

// 1. Ranks Table (Stores your group rank structure)
db.prepare(`
  CREATE TABLE IF NOT EXISTS ranks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    level INTEGER,
    roblox_role_id TEXT
  )
`).run();

// 2. Players Table (Tracks user mapping to their rank)
db.prepare(`
  CREATE TABLE IF NOT EXISTS players (
    roblox_id TEXT PRIMARY KEY,
    username TEXT,
    rank_id INTEGER,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`).run();

// 3. Audit Logs Table (Keeps history of who changed what rank and why)
db.prepare(`
  CREATE TABLE IF NOT EXISTS rank_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    roblox_id TEXT,
    old_rank_id INTEGER,
    new_rank_id INTEGER,
    changed_by TEXT,
    reason TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`).run();


// ─── API ROUTES ───────────────────────────────────────────────────────

// 1. POST /rank/register — Saves a player's profile into the database when they join the game
app.post('/rank/register', (req, res) => {
  if (req.headers['x-api-key'] !== process.env.SERVER_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized game client' });
  }

  const { robloxId, username } = req.body;

  // Inserts the player. If they already exist, it securely updates their username case.
  db.prepare(`
    INSERT INTO players (roblox_id, username, rank_id)
    VALUES (?, ?, 1)
    ON CONFLICT(roblox_id) DO UPDATE SET username = excluded.username
  `).run(robloxId, username);

  res.json({ success: true });
});

// 2. GET /rank/byname/:username — Fetches user row by searching their name
app.get('/rank/byname/:username', (req, res) => {
  if (req.headers['x-api-key'] !== process.env.SERVER_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized game client' });
  }

  const player = db.prepare(
    'SELECT * FROM players WHERE LOWER(username) = LOWER(?)'
  ).get(req.params.username);

  if (!player) return res.status(404).json({ error: 'Not found' });
  res.json(player);
});

// 3. POST /rank — Updates rank in DB, writes history log, and pushes to Roblox Open Cloud API
app.post('/rank', async (req, res) => {
  if (req.headers['x-api-key'] !== process.env.SERVER_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized game client' });
  }

  const { robloxId, rankName, changedBy, reason } = req.body;

  // Locate player in local database
  const player = db.prepare('SELECT * FROM players WHERE roblox_id = ?').get(robloxId);
  if (!player) return res.status(404).json({ error: 'Player not found in database' });

  // Get current ranking metadata
  const currentRank = db.prepare('SELECT * FROM ranks WHERE id = ?').get(player.rank_id);

  let targetRank;
  if (rankName) {
    // Branch A: Direct promotion to a specified name
    targetRank = db.prepare('SELECT * FROM ranks WHERE LOWER(name) = LOWER(?)').get(rankName);
    if (!targetRank) return res.status(400).json({ error: `Unknown rank tier: ${rankName}` });
  } else {
    // Branch B: Incremental step (+1 rank tier escalation)
    targetRank = db.prepare(
      'SELECT * FROM ranks WHERE level > ? ORDER BY level ASC LIMIT 1'
    ).get(currentRank ? currentRank.level : 0);
    if (!targetRank) return res.status(400).json({ error: 'Player is already at maximum tier configuration' });
  }

  // Update backend profile row
  db.prepare(
    'UPDATE players SET rank_id = ?, updated_at = CURRENT_TIMESTAMP WHERE roblox_id = ?'
  ).run(targetRank.id, robloxId);

  // Commit entry into the system history audit log
  db.prepare(`
    INSERT INTO rank_log (roblox_id, old_rank_id, new_rank_id, changed_by, reason)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    robloxId, 
    currentRank ? currentRank.id : null, 
    targetRank.id, 
    changedBy, 
    reason
  );

  // Dispatch network request payload directly to Roblox Open Cloud Group infrastructure APIs
  const rbxRes = await fetch(
    `https://apis.roblox.com/cloud/v2/groups/${process.env.GROUP_ID}/memberships`,
    {
      method: 'PATCH',
      headers: { 
        'x-api-key': process.env.ROBLOX_CLOUD_KEY, 
        'Content-Type': 'application/json' 
      },
      body: JSON.stringify({ 
        userId: robloxId, 
        roleId: targetRank.roblox_role_id 
      }),
    }
  );

  if (!rbxRes.ok) {
    return res.status(500).json({ error: 'Roblox Open Cloud API transaction failed' });
  }

  res.json({ 
    old_rank: currentRank ? currentRank.name : 'Unranked', 
    new_rank: targetRank.name 
  });
});


// ─── START ENVIRONMENT SERVER LISTENERS ────────────────────────────────
// The critical binding wrapper that blocks early application exit patterns.
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Roblox ranking server is live and listening on port ${PORT}!`);
});
