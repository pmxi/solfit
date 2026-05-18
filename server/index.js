const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const nacl = require('tweetnacl');
const bs58 = require('bs58');

// ── Judge Ed25519 keypair ────────────────────────────────
// Persisted to disk so the pubkey survives restarts (matters because
// contests are created with a baked-in judge pubkey).
const JUDGE_KEY_PATH = process.env.JUDGE_KEY_PATH || path.join(__dirname, 'judge.key');

function loadOrCreateJudge() {
  try {
    const raw = fs.readFileSync(JUDGE_KEY_PATH);
    if (raw.length === 64) return nacl.sign.keyPair.fromSecretKey(new Uint8Array(raw));
  } catch { /* fall through */ }
  const kp = nacl.sign.keyPair();
  fs.writeFileSync(JUDGE_KEY_PATH, Buffer.from(kp.secretKey), { mode: 0o600 });
  console.log(`Generated new judge keypair at ${JUDGE_KEY_PATH}`);
  return kp;
}

const judge = loadOrCreateJudge();
const judgePubkeyBase58 = bs58.default
  ? bs58.default.encode(judge.publicKey)
  : bs58.encode(judge.publicKey);
console.log(`Judge pubkey: ${judgePubkeyBase58}`);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(cors());
app.use(express.json());

// In-memory stores
const rooms = new Map();      // code -> Room
const users = new Map();      // userId -> { username }  (persists for session)
const friendships = new Map(); // userId -> Set of friendIds

function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function friendsOf(userId) {
  return [...(friendships.get(userId) ?? [])].map(fid => {
    const info = users.get(fid);
    return info ? { id: fid, username: info.username } : null;
  }).filter(Boolean);
}

function calculatePrizes(players, entryFee) {
  const totalPot = entryFee * players.length * 0.95;
  return players.map((p, i) => ({
    ...p,
    prize: i === 0 ? parseFloat(totalPot.toFixed(3)) : 0,
  }));
}

// ── REST ──────────────────────────────────────────────────

app.post('/api/rooms', (req, res) => {
  const { teamName, gameType, playerName, playerId, walletPubkey } = req.body;
  if (!teamName || !gameType || !playerName || !playerId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  let code;
  do { code = generateCode(); } while (rooms.has(code));

  const room = {
    code, teamName, gameType, hostId: playerId,
    players: [{ id: playerId, name: playerName, isHost: true, isReady: true, walletPubkey: walletPubkey ?? null }],
    settings: { reps: 30, timeLimit: 60, entryFee: 0.1 },
    status: 'lobby',
    contestPda: null,
    createdAt: Date.now(),
  };

  rooms.set(code, room);
  setTimeout(() => rooms.delete(code), 2 * 60 * 60 * 1000);
  res.json({ code, room });
});

app.get('/api/rooms/:code', (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.status === 'playing' || room.status === 'ended') {
    return res.status(409).json({ error: 'Game already in progress' });
  }
  res.json(room);
});

app.get('/health', (_, res) => res.json({ ok: true, rooms: rooms.size, users: users.size }));

// ── Judge endpoints ──────────────────────────────────────

app.get('/api/judge-pubkey', (_req, res) => {
  console.log('[judge] /api/judge-pubkey served', judgePubkeyBase58);
  res.json({ publicKey: judgePubkeyBase58 });
});

app.post('/api/sign', (req, res) => {
  const { messageBase64 } = req.body;
  if (!messageBase64 || typeof messageBase64 !== 'string') {
    console.warn('[judge] /api/sign rejected: missing messageBase64');
    return res.status(400).json({ error: 'messageBase64 required' });
  }
  try {
    const msg = Buffer.from(messageBase64, 'base64');
    const sig = nacl.sign.detached(new Uint8Array(msg), judge.secretKey);
    console.log(`[judge] /api/sign signed ${msg.length}-byte message`);
    res.json({
      signatureBase64: Buffer.from(sig).toString('base64'),
      publicKey: judgePubkeyBase58,
    });
  } catch (e) {
    console.error('[judge] /api/sign error:', e);
    res.status(400).json({ error: String(e) });
  }
});

// ── Socket.io ─────────────────────────────────────────────

io.on('connection', (socket) => {
  let currentRoom = null;
  let currentPlayerId = null;

  // ── Identity registration ──

  socket.on('register-user', ({ userId, username }) => {
    currentPlayerId = userId;
    users.set(userId, { username, socketId: socket.id });
    if (!friendships.has(userId)) friendships.set(userId, new Set());
  });

  socket.on('invite-to-game', ({ roomCode, fromUsername, toId }) => {
    const target = users.get(toId);
    if (target?.socketId) {
      io.to(target.socketId).emit('game-invite', { roomCode, fromUsername });
    }
  });

  // ── Friend system ──

  socket.on('get-friends', ({ userId }) => {
    socket.emit('friends-data', { friends: friendsOf(userId) });
  });

  // Direct-add: looks up by username, adds mutually if found
  socket.on('add-friend', ({ fromId, toUsername }) => {
    let targetId = null;
    for (const [uid, info] of users) {
      if (info.username.toLowerCase() === toUsername.trim().toLowerCase()) {
        targetId = uid;
        break;
      }
    }

    if (!targetId) {
      socket.emit('add-friend-result', { ok: false, message: `No user found with username "${toUsername}". They must have logged in at least once.` });
      return;
    }
    if (targetId === fromId) {
      socket.emit('add-friend-result', { ok: false, message: "You can't add yourself." });
      return;
    }
    if (friendships.get(fromId)?.has(targetId)) {
      socket.emit('add-friend-result', { ok: false, message: 'Already friends.' });
      return;
    }

    // Mutual add
    if (!friendships.has(fromId)) friendships.set(fromId, new Set());
    if (!friendships.has(targetId)) friendships.set(targetId, new Set());
    friendships.get(fromId).add(targetId);
    friendships.get(targetId).add(fromId);

    socket.emit('add-friend-result', { ok: true, message: `${users.get(targetId).username} added!` });
    socket.emit('friends-data', { friends: friendsOf(fromId) });
  });

  socket.on('remove-friend', ({ userId, friendId }) => {
    friendships.get(userId)?.delete(friendId);
    friendships.get(friendId)?.delete(userId);
    socket.emit('friends-data', { friends: friendsOf(userId) });
  });

  // ── Game room events ──

  socket.on('join-room', ({ code, player }) => {
    const room = rooms.get(code);
    if (!room) { socket.emit('error', { message: 'Room not found' }); return; }

    currentRoom = code;
    socket.join(code);

    const existing = room.players.find(p => p.id === player.id);
    if (existing) {
      // Update wallet pubkey if newly provided (e.g. reconnect after connecting Phantom)
      if (player.walletPubkey && !existing.walletPubkey) {
        existing.walletPubkey = player.walletPubkey;
      }
    } else {
      if (room.players.length >= 6) {
        socket.emit('error', { message: 'Room is full' });
        return;
      }
      room.players.push({
        ...player,
        isHost: false,
        isReady: false,
        walletPubkey: player.walletPubkey ?? null,
      });
    }

    io.to(code).emit('lobby-update', room);
  });

  socket.on('set-contest-pda', ({ code, contestPda }) => {
    const room = rooms.get(code);
    if (!room) return;
    if (room.hostId !== currentPlayerId) return; // only host can set
    room.contestPda = contestPda;
    io.to(code).emit('lobby-update', room);
  });

  socket.on('player-ready', ({ code, playerId }) => {
    const room = rooms.get(code);
    if (!room) return;
    room.players = room.players.map(p =>
      p.id === playerId ? { ...p, isReady: true } : p
    );
    io.to(code).emit('lobby-update', room);
  });

  socket.on('update-settings', ({ code, settings }) => {
    const room = rooms.get(code);
    if (!room) return;
    room.settings = { ...room.settings, ...settings };
    io.to(code).emit('settings-update', room.settings);
  });

  socket.on('start-game', ({ code, settings }) => {
    const room = rooms.get(code);
    if (!room) return;
    if (settings) room.settings = { ...room.settings, ...settings };
    room.status = 'playing';
    room.startedAt = Date.now();
    io.to(code).emit('game-start', { settings: room.settings, players: room.players, startedAt: room.startedAt });
  });

  socket.on('rep-update', ({ code, playerId, count }) => {
    socket.to(code).emit('rep-update', { playerId, count });
  });

  socket.on('game-end', ({ code, results }) => {
    const room = rooms.get(code);
    if (!room) return;
    room.status = 'ended';
    const withPrizes = calculatePrizes(results, room.settings.entryFee);
    io.to(code).emit('game-end', withPrizes);
  });

  socket.on('leave-room', ({ code, playerId }) => {
    const room = rooms.get(code);
    if (!room) return;
    room.players = room.players.filter(p => p.id !== playerId);
    socket.leave(code);
    if (room.players.length === 0) {
      rooms.delete(code);
    } else {
      if (room.hostId === playerId) {
        room.players[0].isHost = true;
        room.hostId = room.players[0].id;
      }
      io.to(code).emit('lobby-update', room);
    }
    currentRoom = null;
  });

  socket.on('disconnect', () => {
    if (currentPlayerId) {
      const info = users.get(currentPlayerId);
      if (info && info.socketId === socket.id) {
        users.set(currentPlayerId, { ...info, socketId: null });
      }
    }
    if (!currentRoom || !currentPlayerId) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    room.players = room.players.filter(p => p.id !== currentPlayerId);
    if (room.players.length === 0) {
      rooms.delete(currentRoom);
    } else {
      if (room.hostId === currentPlayerId) {
        room.players[0].isHost = true;
        room.hostId = room.players[0].id;
      }
      io.to(currentRoom).emit('lobby-update', room);
    }
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`SOLFIT server running on http://localhost:${PORT}`);
});
