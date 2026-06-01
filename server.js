// GET /rank/byname/:username
import express from 'express';
import Database from 'better-sqlite3';

const app = express();
const db = new Database('game.db');

// Allow the server to read incoming JSON messages from Roblox
app.use(express.json());
// hello!
app.get('/rank/byname/:username', (req, res) => {
  const player = db.prepare(
    'SELECT * FROM players WHERE LOWER(username) = LOWER(?)'
  ).get(req.params.username);
  if (!player) return res.status(404).json({ error: 'Not found' });
  res.json(player);
});

// Updated POST /rank — handles rankName OR promote-by-1
app.post('/rank', async (req, res) => {
  const { robloxId, username, rankName, changedBy, reason } = req.body;

  const player = db.prepare('SELECT * FROM players WHERE roblox_id = ?').get(robloxId);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const currentRank = db.prepare('SELECT * FROM ranks WHERE id = ?').get(player.rank_id);

  let targetRank;
  if (rankName) {
    targetRank = db.prepare('SELECT * FROM ranks WHERE LOWER(name) = LOWER(?)').get(rankName);
    if (!targetRank) return res.status(400).json({ error: `Unknown rank: ${rankName}` });
  } else {
    targetRank = db.prepare(
      'SELECT * FROM ranks WHERE level > ? ORDER BY level ASC LIMIT 1'
    ).get(currentRank.level);
    if (!targetRank) return res.status(400).json({ error: 'Already at highest rank' });
  }

  // Update DB
  db.prepare(
    'UPDATE players SET rank_id = ?, updated_at = CURRENT_TIMESTAMP WHERE roblox_id = ?'
  ).run(targetRank.id, robloxId);

  // Log it
  db.prepare(`
    INSERT INTO rank_log (roblox_id, old_rank_id, new_rank_id, changed_by, reason)
    VALUES (?, ?, ?, ?, ?)
  `).run(robloxId, currentRank.id, targetRank.id, changedBy, reason);

  // Call Roblox Open Cloud
  const rbxRes = await fetch(
    `https://apis.roblox.com/cloud/v2/groups/${process.env.GROUP_ID}/memberships`,
    {
      method: 'PATCH',
      headers: { 'x-api-key': process.env.ROBLOX_CLOUD_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: robloxId, roleId: targetRank.roblox_role_id }),
    }
  );
  if (!rbxRes.ok) return res.status(500).json({ error: 'Roblox API failed' });

  res.json({ old_rank: currentRank.name, new_rank: targetRank.name });
});
