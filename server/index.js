const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, '../public')));

// ─── State ───────────────────────────────────────────────────────────────────

const rooms = {};        // code → Room
const playerRoom = {};   // socketId → code

const GAME_SEQUENCE = [
  'bullet_barrage',
  'penguin_attack',
  'magma_madness',
];

const ARENA_W = 800;
const ARENA_H = 560;

const CHAR_COLORS = {
  Blue:   '#5b9bd5',
  Pink:   '#e07aaa',
  Yellow: '#f5c842',
  Green:  '#5abf6a',
  Beige:  '#d4c89a',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function startPositions(count) {
  // Evenly distribute start positions in the arena
  const margin = 100;
  const positions = [
    { x: margin, y: margin },
    { x: ARENA_W - margin, y: margin },
    { x: ARENA_W - margin, y: ARENA_H - margin },
    { x: margin, y: ARENA_H - margin },
    { x: ARENA_W / 2, y: margin },
    { x: ARENA_W / 2, y: ARENA_H - margin },
    { x: margin, y: ARENA_H / 2 },
    { x: ARENA_W - margin, y: ARENA_H / 2 },
  ];
  return positions.slice(0, count);
}

function broadcastLobby(code) {
  const room = rooms[code];
  if (!room) return;
  io.to(code).emit('lobby_update', {
    players: room.players.map(p => ({ id: p.id, name: p.name, char: p.char, ready: p.ready })),
    hostId: room.hostId,
    state: room.state,
  });
}

// ─── Socket handling ──────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log('connect', socket.id);

  // ── Create room ──────────────────────────────────────────────────────────
  socket.on('create_room', ({ name, char }) => {
    let code;
    do { code = genCode(); } while (rooms[code]);

    rooms[code] = {
      code,
      hostId: socket.id,
      state: 'lobby',       // lobby | starting | playing | scores
      players: [],
      gameIndex: 0,
      gameLoop: null,
      gameState: null,
      scores: {},           // id → total points
    };

    joinRoom(socket, code, name, char);
  });

  // ── Join room ─────────────────────────────────────────────────────────────
  socket.on('join_room', ({ code, name, char }) => {
    const room = rooms[code];
    if (!room) { socket.emit('error', 'Room not found'); return; }
    if (room.state !== 'lobby') { socket.emit('error', 'Game already started'); return; }
    if (room.players.length >= 8) { socket.emit('error', 'Room full'); return; }

    joinRoom(socket, code, name, char);
  });

  function joinRoom(socket, code, name, char) {
    socket.join(code);
    playerRoom[socket.id] = code;

    const room = rooms[code];
    room.players.push({ id: socket.id, name: name || 'Player', char: char || 'Blue', ready: false });
    room.scores[socket.id] = 0;

    socket.emit('joined', { code, playerId: socket.id, hostId: room.hostId });
    broadcastLobby(code);
  }

  // ── Update character ─────────────────────────────────────────────────────
  socket.on('set_char', ({ char }) => {
    const code = playerRoom[socket.id];
    const room = rooms[code];
    if (!room) return;
    const p = room.players.find(p => p.id === socket.id);
    if (p) { p.char = char; broadcastLobby(code); }
  });

  // ── Rejoin after page navigation ─────────────────────────────────────────
  socket.on('rejoin_game', ({ code, myId }) => {
    const room = rooms[code];
    if (!room) { socket.emit('error', 'Room not found'); return; }

    // Update socket id in room
    const player = room.players.find(p => p.id === myId);
    if (player) {
      const oldId = player.id;
      player.id = socket.id;
      player._disconnectedAt = null; // clear grace period
      const oldScore = room.scores[oldId] || 0;
      delete room.scores[oldId];
      room.scores[socket.id] = oldScore;
      if (room.hostId === oldId) room.hostId = socket.id;
      delete playerRoom[oldId];
    }

    socket.join(code);
    playerRoom[socket.id] = code;

    socket.emit('rejoined', { ok: true, state: room.state, game: GAME_SEQUENCE[room.gameIndex % GAME_SEQUENCE.length] });
  });

  // ── Start game (host only) ────────────────────────────────────────────────
  socket.on('start_game', () => {
    const code = playerRoom[socket.id];
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;
    if (room.players.length < 1) return;

    room.state = 'starting';
    room.gameIndex = 0;
    broadcastLobby(code);

    setTimeout(() => launchCurrentGame(code), 3000);
  });

  // ── Player movement ────────────────────────────────────────────────────────
  socket.on('player_move', ({ x, y }) => {
    const code = playerRoom[socket.id];
    const room = rooms[code];
    if (!room || room.state !== 'playing') return;
    const p = room.players.find(p => p.id === socket.id);
    if (p && p.alive) {
      p.x = Math.max(16, Math.min(ARENA_W - 16, x));
      p.y = Math.max(16, Math.min(ARENA_H - 16, y));
    }
  });

  // ── Client reports own death ───────────────────────────────────────────────
  socket.on('player_died', () => {
    const code = playerRoom[socket.id];
    const room = rooms[code];
    if (!room || room.state !== 'playing') return;
    killPlayer(code, socket.id);
  });

  // ── Disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const code = playerRoom[socket.id];
    if (!code) return;
    delete playerRoom[socket.id];

    const room = rooms[code];
    if (!room) return;

    // Grace period: player might be navigating to game.html
    // Mark as disconnected but keep in room for 8 seconds
    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      player._disconnectedAt = Date.now();
    }

    setTimeout(() => {
      const room = rooms[code];
      if (!room) return;

      // Only remove if still disconnected (not rejoined)
      room.players = room.players.filter(p => {
        if (p.id === socket.id && p._disconnectedAt) return false;
        return true;
      });

      if (room.players.length === 0) {
        if (room.gameLoop) clearInterval(room.gameLoop);
        delete rooms[code];
        return;
      }

      if (room.hostId === socket.id) room.hostId = room.players[0].id;
      if (room.state === 'lobby' || room.state === 'scores') broadcastLobby(code);
      if (room.state === 'playing') checkGameEnd(code);
    }, 8000);
  });
});

// ─── Game launcher ────────────────────────────────────────────────────────────

function launchCurrentGame(code) {
  const room = rooms[code];
  if (!room) return;

  const gameName = GAME_SEQUENCE[room.gameIndex % GAME_SEQUENCE.length];

  // Assign start positions
  const positions = startPositions(room.players.length);
  room.players.forEach((p, i) => {
    p.x = positions[i].x;
    p.y = positions[i].y;
    p.alive = true;
  });

  room.state = 'playing';
  io.to(code).emit('game_start', {
    game: gameName,
    players: room.players.map(p => ({
      id: p.id, name: p.name, char: p.char, x: p.x, y: p.y,
      color: CHAR_COLORS[p.char] || '#ffffff',
    })),
    arenaW: ARENA_W,
    arenaH: ARENA_H,
  });

  if (gameName === 'bullet_barrage') startBulletBarrage(code);
  else if (gameName === 'penguin_attack') startPenguinAttack(code);
  else if (gameName === 'magma_madness') startMagmaMadness(code);
}

// ─── Kill / end game ─────────────────────────────────────────────────────────

function killPlayer(code, id) {
  const room = rooms[code];
  if (!room) return;
  const p = room.players.find(p => p.id === id);
  if (!p || !p.alive) return;

  p.alive = false;
  p.deathTime = Date.now();

  const aliveCount = room.players.filter(p => p.alive).length;
  const totalCount = room.players.length;

  // Award survival points: last alive gets most
  // Position from bottom: (totalCount - aliveCount) gives rank
  const rank = totalCount - aliveCount; // 0 = first to die
  // First to die: 0pts, last: 1000pts — we award later in endGame

  io.to(code).emit('player_died', { id, aliveCount });
  checkGameEnd(code);
}

function checkGameEnd(code) {
  const room = rooms[code];
  if (!room) return;

  const alive = room.players.filter(p => p.alive);
  if (alive.length > 1) return; // still going

  endGame(code);
}

function endGame(code) {
  const room = rooms[code];
  if (!room || room.state !== 'playing') return;

  if (room.gameLoop) { clearInterval(room.gameLoop); room.gameLoop = null; }
  room.state = 'scores';

  // Calculate points: survive rank → points
  const players = [...room.players].sort((a, b) => (b.deathTime || Infinity) - (a.deathTime || Infinity));
  const total = players.length;
  players.forEach((p, rank) => {
    const pts = Math.round((rank / Math.max(1, total - 1)) * 1000);
    room.scores[p.id] = (room.scores[p.id] || 0) + pts;
  });

  const scoreList = room.players.map(p => ({
    id: p.id, name: p.name, char: p.char,
    roundPts: players.indexOf(p) >= 0 ? Math.round((players.indexOf(p) / Math.max(1, total - 1)) * 1000) : 0,
    totalPts: room.scores[p.id] || 0,
  }));

  io.to(code).emit('game_over', { scores: scoreList });

  // Auto-advance to next game after 8s
  setTimeout(() => {
    if (!rooms[code]) return;
    room.gameIndex++;
    if (room.gameIndex >= GAME_SEQUENCE.length) {
      // Game night over
      io.to(code).emit('game_night_over', { scores: scoreList });
      room.state = 'lobby';
      broadcastLobby(code);
    } else {
      room.state = 'starting';
      setTimeout(() => launchCurrentGame(code), 3000);
    }
  }, 8000);
}

// ─── BULLET BARRAGE ───────────────────────────────────────────────────────────

function startBulletBarrage(code) {
  const room = rooms[code];
  let bulletId = 0;
  let bullets = [];
  const startTime = Date.now();
  let lastSpawn = 0;
  let spawnInterval = 1200; // ms, decreases over time

  room.gameLoop = setInterval(() => {
    const room = rooms[code];
    if (!room || room.state !== 'playing') return;

    const now = Date.now();
    const elapsed = now - startTime;

    // Increase difficulty
    spawnInterval = Math.max(300, 1200 - elapsed * 0.04);

    // Spawn bullets
    if (now - lastSpawn > spawnInterval) {
      lastSpawn = now;
      const count = elapsed > 20000 ? 2 : 1;
      for (let i = 0; i < count; i++) {
        bullets.push(spawnBullet(bulletId++, elapsed));
      }
    }

    // Move bullets
    const dt = 0.05; // 50ms in seconds
    bullets.forEach(b => { b.x += b.vx * dt; b.y += b.vy * dt; });

    // Remove off-screen
    bullets = bullets.filter(b => b.x > -60 && b.x < ARENA_W + 60 && b.y > -60 && b.y < ARENA_H + 60);

    // Server-side collision check
    const alive = room.players.filter(p => p.alive);
    alive.forEach(p => {
      bullets.forEach(b => {
        const dx = p.x - b.x, dy = p.y - b.y;
        if (dx * dx + dy * dy < (16 + b.r) * (16 + b.r)) {
          killPlayer(code, p.id);
        }
      });
    });

    // Broadcast tick
    io.to(code).emit('game_tick', {
      bullets: bullets.map(b => ({ id: b.id, x: b.x, y: b.y, r: b.r, color: b.color })),
      players: room.players.map(p => ({ id: p.id, x: p.x, y: p.y, alive: p.alive })),
      elapsed,
    });

    // Time limit
    if (elapsed > 90000) endGame(code);
  }, 50);
}

function spawnBullet(id, elapsed) {
  const side = Math.floor(Math.random() * 4);
  const baseSpeed = 150 + Math.min(200, elapsed * 0.003);
  const speed = baseSpeed + Math.random() * 80;
  const r = 8 + Math.random() * 8;

  const colors = ['#ff4444', '#ff8800', '#ffff00', '#44ffff', '#ff44ff'];
  const color = colors[Math.floor(Math.random() * colors.length)];

  let x, y, vx, vy;
  switch (side) {
    case 0: x = Math.random() * ARENA_W; y = -r; vx = (Math.random() - 0.5) * 80; vy = speed; break;
    case 1: x = ARENA_W + r; y = Math.random() * ARENA_H; vx = -speed; vy = (Math.random() - 0.5) * 80; break;
    case 2: x = Math.random() * ARENA_W; y = ARENA_H + r; vx = (Math.random() - 0.5) * 80; vy = -speed; break;
    default: x = -r; y = Math.random() * ARENA_H; vx = speed; vy = (Math.random() - 0.5) * 80;
  }

  return { id, x, y, vx, vy, r, color };
}

// ─── PENGUIN ATTACK ───────────────────────────────────────────────────────────

function startPenguinAttack(code) {
  const room = rooms[code];
  let penguinId = 0;
  let penguins = [];
  const startTime = Date.now();
  let lastSpawn = 0;

  room.gameLoop = setInterval(() => {
    const room = rooms[code];
    if (!room || room.state !== 'playing') return;

    const now = Date.now();
    const elapsed = now - startTime;

    if (now - lastSpawn > 2000) {
      lastSpawn = now;
      penguins.push(spawnPenguin(penguinId++));
    }

    const dt = 0.05;
    penguins.forEach(pg => { pg.x += pg.vx * dt; });
    penguins = penguins.filter(pg => pg.x > -80 && pg.x < ARENA_W + 80);

    // Collision
    const alive = room.players.filter(p => p.alive);
    alive.forEach(p => {
      penguins.forEach(pg => {
        const dx = p.x - pg.x, dy = p.y - pg.y;
        if (Math.abs(dx) < 28 && Math.abs(dy) < 32) {
          killPlayer(code, p.id);
        }
      });
    });

    io.to(code).emit('game_tick', {
      penguins: penguins.map(pg => ({ id: pg.id, x: pg.x, y: pg.y })),
      players: room.players.map(p => ({ id: p.id, x: p.x, y: p.y, alive: p.alive })),
      elapsed,
    });

    if (elapsed > 60000) endGame(code);
  }, 50);
}

function spawnPenguin(id) {
  const fromLeft = Math.random() > 0.5;
  const row = Math.floor(Math.random() * 4); // 4 lanes
  const laneY = 80 + row * 120;
  const speed = 80 + Math.random() * 80;
  return {
    id,
    x: fromLeft ? -40 : ARENA_W + 40,
    y: laneY,
    vx: fromLeft ? speed : -speed,
  };
}

// ─── MAGMA MADNESS ────────────────────────────────────────────────────────────

function startMagmaMadness(code) {
  const room = rooms[code];
  const COLS = 16, ROWS = 11;
  const startTime = Date.now();

  // Init tiles: all solid
  const tiles = Array.from({ length: ROWS }, () => Array(COLS).fill(1));

  // Schedule tile breaks
  let breakQueue = [];
  const totalTiles = COLS * ROWS;
  for (let i = 0; i < totalTiles; i++) {
    breakQueue.push({ col: i % COLS, row: Math.floor(i / COLS), t: 5000 + Math.random() * 40000 });
  }
  breakQueue.sort((a, b) => a.t - b.t);
  let breakIdx = 0;

  room.gameLoop = setInterval(() => {
    const room = rooms[code];
    if (!room || room.state !== 'playing') return;

    const elapsed = Date.now() - startTime;
    const tileW = ARENA_W / COLS, tileH = ARENA_H / ROWS;

    // Break tiles
    while (breakIdx < breakQueue.length && breakQueue[breakIdx].t <= elapsed) {
      const { col, row } = breakQueue[breakIdx];
      tiles[row][col] = 0;
      breakIdx++;
    }

    // Collision: player standing on broken tile → die
    room.players.filter(p => p.alive).forEach(p => {
      const col = Math.floor(p.x / tileW);
      const row = Math.floor(p.y / tileH);
      if (row >= 0 && row < ROWS && col >= 0 && col < COLS && tiles[row][col] === 0) {
        killPlayer(code, p.id);
      }
    });

    io.to(code).emit('game_tick', {
      tiles,
      players: room.players.map(p => ({ id: p.id, x: p.x, y: p.y, alive: p.alive })),
      elapsed,
    });

    if (elapsed > 60000) endGame(code);
  }, 100);
}

// ─── Start server ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`BLOBZ2 running on port ${PORT}`));
