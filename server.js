const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
let Pool = null;
try {
  ({ Pool } = require('pg'));
} catch (_) {
  Pool = null;
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 10;
const ANSWER_SECONDS = 180;
const VOTE_SECONDS = 60;
const REPORT_THRESHOLD = 0.4;
const BAN_MS = 7 * 24 * 60 * 60 * 1000;
const ELO_K = 32;
const MIN_PLAYERS_TO_START = Number(process.env.MIN_PLAYERS_TO_START || 2);

const DATA_DIR = path.join(__dirname, 'data');
const SAVE_FILE = path.join(DATA_DIR, 'stats.json');

const presetTopics = [
  'こんなコンビニは二度と行きたくない。どんなコンビニ？',
  '校長先生が朝礼で突然言い出した衝撃の一言とは？',
  'AI搭載の冷蔵庫、余計すぎる機能とは？',
  '一瞬で売れなくなった新商品の名前とは？',
  '勇者が魔王城に着いて最初に後悔した理由とは？',
  '世界一どうでもいいギネス記録とは？',
  'この動物園、攻めすぎている。何があった？',
  '美容院で絶対に言われたくない一言とは？'
];

const rooms = new Map();
const bans = new Map();
let savedData = { users: {}, stats: {} };
let dbPool = null;
let useDatabase = false;

function now() { return Date.now(); }
function makeRoomCode() {
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}
function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}
function normalizeLoginId(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 24);
}
function cleanDisplayName(value) {
  return String(value || '').trim().slice(0, 16);
}
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(String(password), salt, 100000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, originalHash] = String(stored || '').split(':');
  if (!salt || !originalHash) return false;
  const candidate = hashPassword(password, salt).split(':')[1];
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(originalHash));
}
function defaultStats() {
  return {
    trophies: 0,
    rating: 1000,
    reportKicks: 0,
    wins: 0,
    answers: 0,
    totalVotes: 0,
    games: 0,
    banUntil: 0
  };
}
function hydrateBans() {
  bans.clear();
  for (const [userId, stat] of Object.entries(savedData.stats || {})) {
    if (stat.banUntil && stat.banUntil > now()) bans.set(userId, stat.banUntil);
  }
}
function normalizeSavedData(parsed) {
  if (!parsed || typeof parsed !== 'object') return { users: {}, stats: {} };
  // 旧版の { users: { name: stats } } 形式も軽く救済する
  if (parsed.users && !parsed.stats) return { users: {}, stats: parsed.users || {} };
  return { users: parsed.users || {}, stats: parsed.stats || {} };
}
async function initStorage() {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl && Pool) {
    try {
      dbPool = new Pool({
        connectionString: databaseUrl,
        ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false }
      });
      await dbPool.query(`
        CREATE TABLE IF NOT EXISTS oogiri_app_state (
          key TEXT PRIMARY KEY,
          value JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      const result = await dbPool.query('SELECT value FROM oogiri_app_state WHERE key = $1', ['savedData']);
      savedData = normalizeSavedData(result.rows[0]?.value);
      hydrateBans();
      useDatabase = true;
      console.log('Storage: PostgreSQL / Supabase mode');
      return;
    } catch (error) {
      console.error('Database storage init failed. Falling back to JSON file:', error.message);
      useDatabase = false;
    }
  }
  loadSaveDataFromFile();
  console.log('Storage: local JSON file mode');
}
function loadSaveDataFromFile() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(SAVE_FILE)) {
      savedData = { users: {}, stats: {} };
      saveData();
      return;
    }
    const parsed = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
    savedData = normalizeSavedData(parsed);
    hydrateBans();
  } catch (error) {
    console.error('Save data load failed:', error);
    savedData = { users: {}, stats: {} };
  }
}
function saveData() {
  if (useDatabase && dbPool) {
    dbPool.query(
      `INSERT INTO oogiri_app_state (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      ['savedData', savedData]
    ).catch(error => console.error('Database save failed:', error.message));
    return;
  }
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tempFile = SAVE_FILE + '.tmp';
    fs.writeFileSync(tempFile, JSON.stringify(savedData, null, 2));
    fs.renameSync(tempFile, SAVE_FILE);
  } catch (error) {
    console.error('Save data write failed:', error);
  }
}
function getUserByLoginId(loginId) {
  return Object.values(savedData.users).find(user => user.loginId === loginId);
}
function publicUser(user) {
  if (!user) return null;
  return { id: user.id, loginId: user.loginId, displayName: user.displayName };
}
function getSavedStats(userId) {
  if (!savedData.stats[userId]) savedData.stats[userId] = defaultStats();
  return savedData.stats[userId];
}
function applySavedStats(player) {
  const stat = getSavedStats(player.userId);
  player.trophies = stat.trophies || 0;
  player.rating = stat.rating || 1000;
  player.reportKicks = stat.reportKicks || 0;
  player.wins = stat.wins || 0;
  player.answers = stat.answers || 0;
  player.totalVotes = stat.totalVotes || 0;
  player.games = stat.games || 0;
}
function persistPlayer(player) {
  const stat = getSavedStats(player.userId);
  stat.displayName = player.name;
  stat.loginId = player.loginId;
  stat.trophies = player.trophies;
  stat.rating = player.rating;
  stat.reportKicks = player.reportKicks;
  stat.wins = player.wins;
  stat.answers = player.answers;
  stat.totalVotes = player.totalVotes;
  stat.games = player.games || 0;
  stat.updatedAt = new Date().toISOString();
  saveData();
}
function setBan(userId, until) {
  bans.set(userId, until);
  const stat = getSavedStats(userId);
  stat.banUntil = until;
  stat.updatedAt = new Date().toISOString();
  saveData();
}
function requireLogin(socket, cb) {
  if (!socket.data.user) {
    cb?.({ ok: false, error: 'ログインしてください。' });
    return false;
  }
  return true;
}

function expectedScore(myRating, opponentRating) {
  return 1 / (1 + Math.pow(10, (opponentRating - myRating) / 400));
}
function calculateEloChanges(players) {
  const list = players.filter(p => p.roundVotes !== undefined);
  const changes = new Map();
  for (const player of list) changes.set(player.id, 0);
  if (list.length < 2) return changes;

  for (const player of list) {
    let delta = 0;
    for (const opponent of list) {
      if (player.id === opponent.id) continue;
      const actual = player.roundVotes > opponent.roundVotes ? 1 : player.roundVotes < opponent.roundVotes ? 0 : 0.5;
      const expected = expectedScore(player.ratingBeforeRound, opponent.ratingBeforeRound);
      delta += ELO_K * (actual - expected);
    }
    changes.set(player.id, Math.round(delta / (list.length - 1)));
  }
  return changes;
}

function publicPlayer(player) {
  return {
    id: player.id,
    userId: player.userId,
    loginId: player.loginId,
    name: player.name,
    trophies: player.trophies,
    rating: player.rating,
    wins: player.wins,
    answers: player.answers,
    totalVotes: player.totalVotes,
    reportKicks: player.reportKicks,
    games: player.games || 0,
    isHost: player.isHost
  };
}
function getRankingBoards(room) {
  const players = [...room.players.values()].map(publicPlayer);
  const trophyRanking = [...players].sort((a, b) => b.trophies - a.trophies || b.totalVotes - a.totalVotes || a.name.localeCompare(b.name, 'ja'));
  const ratingRanking = [...players].sort((a, b) => b.rating - a.rating || b.wins - a.wins || a.name.localeCompare(b.name, 'ja'));
  return { trophyRanking, ratingRanking };
}
function getPublicRoom(room) {
  const remaining = room.phaseEndsAt ? Math.max(0, Math.ceil((room.phaseEndsAt - now()) / 1000)) : 0;
  return {
    code: room.code,
    phase: room.phase,
    topic: room.topic,
    topicChooserName: room.topicChooserName,
    players: [...room.players.values()].map(publicPlayer),
    ...getRankingBoards(room),
    answers: room.answers.map(a => ({
      id: a.id,
      text: a.text,
      authorName: room.phase === 'result' ? a.authorName : '匿名',
      votes: room.phase === 'result' ? a.votes : undefined
    })),
    results: room.results,
    remaining,
    minPlayersToStart: MIN_PLAYERS_TO_START
  };
}
function getPublicRoomSummary(room) {
  return {
    code: room.code,
    phase: room.phase,
    phaseName: {
      waiting: '待機中',
      topic: 'お題決め',
      answer: '回答中',
      vote: '投票中',
      result: '結果発表'
    }[room.phase] || room.phase,
    topic: room.topic,
    playerCount: room.players.size,
    maxPlayers: MAX_PLAYERS,
    hostName: [...room.players.values()].find(p => p.isHost)?.name || '不明',
    canJoin: room.phase === 'waiting' && room.players.size < MAX_PLAYERS
  };
}
function getRoomList() {
  return [...rooms.values()]
    .map(getPublicRoomSummary)
    .sort((a, b) => Number(b.canJoin) - Number(a.canJoin) || b.playerCount - a.playerCount || a.code.localeCompare(b.code));
}
function emitRoomList() {
  io.emit('rooms:update', getRoomList());
}
function emitRoom(room) {
  io.to(room.code).emit('room:update', getPublicRoom(room));
  emitRoomList();
}
function addPlayer(room, socket, isHost = false) {
  const user = socket.data.user;
  const bannedUntil = bans.get(user.id);
  if (bannedUntil && bannedUntil > now()) {
    return { ok: false, error: '一週間ログイン制限中です。' };
  }
  if ([...room.players.values()].some(player => player.userId === user.id)) {
    return { ok: false, error: 'このユーザーはすでに入室しています。別ブラウザで同時参加はできません。' };
  }

  const player = {
    id: socket.id,
    userId: user.id,
    loginId: user.loginId,
    name: user.displayName,
    trophies: 0,
    rating: 1000,
    reportKicks: 0,
    wins: 0,
    answers: 0,
    totalVotes: 0,
    games: 0,
    lastRatingChange: 0,
    isHost
  };
  applySavedStats(player);
  room.players.set(socket.id, player);
  socket.data.roomCode = room.code;
  socket.data.userId = user.id;
  socket.join(room.code);
  return { ok: true, player };
}
function createRoom(hostSocket) {
  let code;
  do code = makeRoomCode(); while (rooms.has(code));
  const room = {
    code,
    phase: 'waiting',
    topic: '',
    topicChooserId: null,
    topicChooserName: '',
    players: new Map(),
    answers: [],
    votes: new Map(),
    reports: new Map(),
    results: [],
    phaseEndsAt: null,
    timer: null
  };
  rooms.set(code, room);
  const result = addPlayer(room, hostSocket, true);
  if (!result.ok) {
    rooms.delete(code);
    return { ok: false, error: result.error };
  }
  return { ok: true, room };
}
function leaveCurrentRoom(socket) {
  const room = rooms.get(socket.data.roomCode);
  if (!room) return;
  const wasHost = room.players.get(socket.id)?.isHost;
  room.players.delete(socket.id);
  socket.leave(room.code);
  socket.data.roomCode = null;
  if (room.players.size === 0) cleanupRoom(room);
  else {
    if (wasHost) room.players.values().next().value.isHost = true;
    emitRoom(room);
  }
}
function cleanupRoom(room) {
  if (room.timer) clearTimeout(room.timer);
  rooms.delete(room.code);
  emitRoomList();
}
function chooseTopicPlayer(room) {
  const players = [...room.players.values()];
  const selected = players[Math.floor(Math.random() * players.length)];
  room.topicChooserId = selected.id;
  room.topicChooserName = selected.name;
  return selected;
}
function startTopicSelect(room) {
  if (room.players.size < MIN_PLAYERS_TO_START) return;
  room.phase = 'topic';
  room.topic = '';
  room.answers = [];
  room.votes = new Map();
  room.reports = new Map();
  room.results = [];
  room.phaseEndsAt = null;
  chooseTopicPlayer(room);
  emitRoom(room);
}
function startAnswerPhase(room, topic) {
  room.phase = 'answer';
  room.topic = String(topic || presetTopics[Math.floor(Math.random() * presetTopics.length)]).slice(0, 80);
  room.answers = [];
  room.votes = new Map();
  room.results = [];
  room.phaseEndsAt = now() + ANSWER_SECONDS * 1000;
  emitRoom(room);
  if (room.timer) clearTimeout(room.timer);
  room.timer = setTimeout(() => startVotePhase(room), ANSWER_SECONDS * 1000);
}
function startVotePhase(room) {
  room.phase = 'vote';
  room.phaseEndsAt = now() + VOTE_SECONDS * 1000;
  emitRoom(room);
  if (room.timer) clearTimeout(room.timer);
  room.timer = setTimeout(() => finishRound(room), VOTE_SECONDS * 1000);
}
function finishRound(room) {
  for (const answer of room.answers) answer.votes = 0;
  for (const answerId of room.votes.values()) {
    const answer = room.answers.find(a => a.id === answerId);
    if (answer) answer.votes += 1;
  }
  room.answers.sort((a, b) => b.votes - a.votes);
  const winnerVotes = room.answers[0]?.votes || 0;
  const bestAnswerIds = new Set(room.answers.filter(a => a.votes === winnerVotes && winnerVotes > 0).map(a => a.id));

  for (const player of room.players.values()) {
    player.lastRatingChange = 0;
    player.roundVotes = 0;
    player.ratingBeforeRound = player.rating;
  }

  for (const answer of room.answers) {
    const player = room.players.get(answer.authorId);
    if (!player) continue;
    player.roundVotes += answer.votes;
  }

  const eloTargets = [...room.players.values()].filter(player => room.answers.some(answer => answer.authorId === player.id));
  const eloChanges = calculateEloChanges(eloTargets);

  for (const player of eloTargets) {
    const ratingChange = eloChanges.get(player.id) || 0;
    player.rating = Math.max(100, player.rating + ratingChange);
    player.lastRatingChange = ratingChange;
  }

  for (const answer of room.answers) {
    const player = room.players.get(answer.authorId);
    if (!player) continue;
    const isWinner = bestAnswerIds.has(answer.id);
    const trophyBonus = isWinner ? 30 : answer.votes * 10;

    player.answers += 1;
    player.totalVotes += answer.votes;
    player.trophies += trophyBonus;
    if (isWinner) player.wins += 1;
  }

  room.results = room.answers.map((a, index) => {
    const player = room.players.get(a.authorId);
    return {
      rank: index + 1,
      answer: a.text,
      authorName: a.authorName,
      loginId: player?.loginId || '',
      votes: a.votes,
      trophyGain: bestAnswerIds.has(a.id) ? 30 : a.votes * 10,
      ratingBefore: player?.ratingBeforeRound || player?.rating || 1000,
      ratingAfter: player?.rating || 1000,
      ratingChange: player?.lastRatingChange || 0
    };
  });

  for (const player of room.players.values()) {
    if (room.answers.some(answer => answer.authorId === player.id)) player.games = (player.games || 0) + 1;
    delete player.roundVotes;
    delete player.ratingBeforeRound;
    persistPlayer(player);
  }
  room.phase = 'result';
  room.phaseEndsAt = null;
  emitRoom(room);
}
function kickPlayerByReports(room, targetId) {
  const target = room.players.get(targetId);
  if (!target) return;
  target.reportKicks += 1;
  io.to(target.id).emit('system:message', '通報により部屋から退出しました。');
  io.sockets.sockets.get(target.id)?.leave(room.code);
  room.players.delete(targetId);
  persistPlayer(target);
  if (target.reportKicks >= 2) setBan(target.userId, now() + BAN_MS);
  if (room.players.size === 0) cleanupRoom(room);
  else emitRoom(room);
}

loadSaveData();

io.on('connection', socket => {
  socket.emit('rooms:update', getRoomList());
  socket.on('auth:register', ({ loginId, displayName, password }, cb) => {
    const cleanLoginId = normalizeLoginId(loginId);
    const cleanName = cleanDisplayName(displayName) || cleanLoginId;
    const pass = String(password || '');

    if (cleanLoginId.length < 3) return cb?.({ ok: false, error: 'ログインIDは3文字以上にしてください。英数字、_、-、. が使えます。' });
    if (cleanName.length < 1) return cb?.({ ok: false, error: '表示名を入力してください。' });
    if (pass.length < 4) return cb?.({ ok: false, error: 'パスワードは4文字以上にしてください。' });
    if (getUserByLoginId(cleanLoginId)) return cb?.({ ok: false, error: 'そのログインIDはすでに使われています。' });

    const user = {
      id: makeId('user'),
      loginId: cleanLoginId,
      displayName: cleanName,
      passwordHash: hashPassword(pass),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    savedData.users[user.id] = user;
    savedData.stats[user.id] = defaultStats();
    saveData();
    socket.data.user = user;
    cb?.({ ok: true, user: publicUser(user), stats: getSavedStats(user.id) });
  });

  socket.on('auth:login', ({ loginId, password }, cb) => {
    const cleanLoginId = normalizeLoginId(loginId);
    const user = getUserByLoginId(cleanLoginId);
    if (!user || !verifyPassword(password || '', user.passwordHash)) {
      return cb?.({ ok: false, error: 'ログインIDまたはパスワードが違います。' });
    }
    socket.data.user = user;
    cb?.({ ok: true, user: publicUser(user), stats: getSavedStats(user.id) });
  });

  socket.on('auth:updateName', ({ displayName }, cb) => {
    if (!requireLogin(socket, cb)) return;
    const cleanName = cleanDisplayName(displayName);
    if (!cleanName) return cb?.({ ok: false, error: '表示名を入力してください。' });
    const user = savedData.users[socket.data.user.id];
    user.displayName = cleanName;
    user.updatedAt = new Date().toISOString();
    socket.data.user = user;
    const room = rooms.get(socket.data.roomCode);
    const player = room?.players.get(socket.id);
    if (player) {
      player.name = cleanName;
      persistPlayer(player);
      emitRoom(room);
    }
    saveData();
    cb?.({ ok: true, user: publicUser(user) });
  });

  socket.on('auth:logout', cb => {
    leaveCurrentRoom(socket);
    socket.data.user = null;
    cb?.({ ok: true });
  });

  socket.on('room:create', (_, cb) => {
    if (!requireLogin(socket, cb)) return;
    leaveCurrentRoom(socket);
    const created = createRoom(socket);
    if (!created.ok) return cb?.(created);
    cb?.({ ok: true, room: getPublicRoom(created.room) });
    emitRoom(created.room);
  });

  socket.on('room:join', ({ code }, cb) => {
    if (!requireLogin(socket, cb)) return;
    const room = rooms.get(String(code || '').toUpperCase());
    if (!room) return cb?.({ ok: false, error: '部屋が見つかりません。' });
    if (room.players.size >= MAX_PLAYERS) return cb?.({ ok: false, error: '部屋が満員です。' });
    if (room.phase !== 'waiting') return cb?.({ ok: false, error: '開始済みの部屋には参加できません。' });
    leaveCurrentRoom(socket);
    const result = addPlayer(room, socket, false);
    if (!result.ok) return cb?.(result);
    cb?.({ ok: true, room: getPublicRoom(room) });
    emitRoom(room);
  });

  socket.on('room:list', cb => {
    cb?.({ ok: true, rooms: getRoomList() });
  });

  socket.on('room:quickJoin', (_, cb) => {
    if (!requireLogin(socket, cb)) return;
    const room = getRoomList().find(r => r.canJoin);
    if (!room) return cb?.({ ok: false, error: '参加できる部屋がありません。部屋を作成してください。' });
    const target = rooms.get(room.code);
    leaveCurrentRoom(socket);
    const result = addPlayer(target, socket, false);
    if (!result.ok) return cb?.(result);
    cb?.({ ok: true, room: getPublicRoom(target) });
    emitRoom(target);
  });

  socket.on('room:leave', cb => {
    leaveCurrentRoom(socket);
    cb?.({ ok: true });
  });

  socket.on('round:start', () => {
    const room = rooms.get(socket.data.roomCode);
    const player = room?.players.get(socket.id);
    if (room && player?.isHost) startTopicSelect(room);
  });

  socket.on('topic:submit', ({ topic }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'topic') return;
    if (socket.id !== room.topicChooserId) return;
    startAnswerPhase(room, topic);
  });

  socket.on('topic:preset', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'topic') return;
    if (socket.id !== room.topicChooserId) return;
    startAnswerPhase(room, presetTopics[Math.floor(Math.random() * presetTopics.length)]);
  });

  socket.on('answer:submit', ({ text }) => {
    const room = rooms.get(socket.data.roomCode);
    const player = room?.players.get(socket.id);
    if (!room || !player || room.phase !== 'answer') return;
    const answerText = String(text || '').trim().slice(0, 120);
    if (!answerText) return;
    room.answers.push({
      id: Math.random().toString(36).slice(2),
      text: answerText,
      authorId: player.id,
      authorName: player.name,
      votes: 0
    });
    emitRoom(room);
  });

  socket.on('vote:submit', ({ answerId }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'vote') return;
    const answer = room.answers.find(a => a.id === answerId);
    if (!answer || answer.authorId === socket.id) return;
    room.votes.set(socket.id, answerId);
    emitRoom(room);
  });

  socket.on('report:player', ({ targetId }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.players.has(targetId) || targetId === socket.id) return;
    if (!room.reports.has(targetId)) room.reports.set(targetId, new Set());
    const reports = room.reports.get(targetId);
    reports.add(socket.id);
    const needed = Math.ceil(room.players.size * REPORT_THRESHOLD);
    if (reports.size >= needed) kickPlayerByReports(room, targetId);
    else emitRoom(room);
  });

  socket.on('disconnect', () => {
    leaveCurrentRoom(socket);
  });
});

initStorage().then(() => {
  server.listen(PORT, () => console.log(`Oogiri app running on http://localhost:${PORT}`));
}).catch(error => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
