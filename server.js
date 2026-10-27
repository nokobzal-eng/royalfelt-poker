// Multiplayer server: serves the web client, signs members in (phone + admin approval)
// and connects them to the lobby over Socket.IO.
const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { Lobby } = require('./shared/lobby');
const { Auth } = require('./auth');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const RECONNECT_GRACE_MS = 60000;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use('/shared', express.static(path.join(__dirname, 'shared')));
app.get('/healthz', (req, res) => res.send('ok'));
// Profile pictures are kept with the member record as small data URLs and served as images.
app.get('/avatar/:uid', (req, res) => {
  const u = auth.users[req.params.uid];
  const m = u && u.avatar && /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(u.avatar);
  if (!m) return res.status(404).end();
  res.set('Content-Type', m[1]).set('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(Buffer.from(m[2], 'base64'));
});
const server = http.createServer(app);
const io = new Server(server);

const auth = new Auth({
  file: path.join(DATA_DIR, 'users.json'),
  adminPhone: process.env.ADMIN_PHONE,
  adminPin: process.env.ADMIN_PIN,
});

let saveTimer = null;
const bankFile = path.join(DATA_DIR, 'bankrolls.json');
const store = {
  load() {
    try { return JSON.parse(fs.readFileSync(bankFile, 'utf8')); } catch { return {}; }
  },
  save(map) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(bankFile, JSON.stringify(map, null, 1));
    }, 1000);
  },
};

// Each player id can have several sockets (e.g. phone + laptop).
const socketsOf = new Map();
const leaveTimers = new Map();
const waiting = new Map(); // uid -> Set(socket) waiting for approval

const lobby = new Lobby({
  store,
  send(playerId, ev, data) {
    for (const sid of socketsOf.get(playerId) || []) io.to(sid).emit(ev, data);
  },
});

const pidOf = (uid) => 'u:' + uid;
// The version in the query string busts the browser cache when the picture changes.
const avatarUrl = (u) => (u.avatar ? `/avatar/${u.uid}?v=${u.avatarAt || 0}` : null);
const MAX_AVATAR = 150000;
const admins = () => Object.values(auth.users).filter((u) => u.isAdmin).map((u) => pidOf(u.uid));

function adminPush() {
  const data = { users: auth.list().map((u) => ({ ...u, chips: lobby.chips(pidOf(u.uid)) })), pending: auth.pendingCount() };
  for (const pid of admins()) for (const sid of socketsOf.get(pid) || []) io.to(sid).emit('admin', data);
}

function kick(uid) {
  const pid = pidOf(uid);
  for (const sid of socketsOf.get(pid) || []) {
    const s = io.sockets.sockets.get(sid);
    if (s) { s.emit('auth', { status: 'blocked' }); s.disconnect(true); }
  }
  socketsOf.delete(pid);
  lobby.disconnect(pid);
}

io.on('connection', (socket) => {
  let playerId = null;
  let user = null;

  socket.on('login', (creds, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    if (typeof creds !== 'object' || !creds) return reply({ error: 'פרטי כניסה חסרים' });
    if (Lobby.isBotName(creds.name)) return reply({ error: 'הכינוי שמור' });
    const r = auth.login(creds);
    if (r.error) return reply({ error: r.error });
    if (r.status === 'blocked') return reply({ status: 'blocked' });
    if (r.status === 'pending') {
      if (!waiting.has(r.user.uid)) waiting.set(r.user.uid, new Set());
      waiting.get(r.user.uid).add(socket);
      socket.on('disconnect', () => waiting.get(r.user.uid)?.delete(socket));
      reply({ status: 'pending', token: r.token, newDevice: !!r.newDevice });
      for (const pid of admins()) for (const sid of socketsOf.get(pid) || []) {
        io.to(sid).emit('admin:request', { name: r.user.name, phone: r.user.phone });
      }
      return adminPush();
    }
    user = r.user;
    const id = pidOf(user.uid);
    if (!socketsOf.has(id)) socketsOf.set(id, new Set());
    socketsOf.get(id).add(socket.id);
    if (playerId && playerId !== id) socketsOf.get(playerId)?.delete(socket.id);
    playerId = id;
    clearTimeout(leaveTimers.get(playerId));
    reply({ status: 'approved', token: r.token, isAdmin: !!user.isAdmin });
    lobby.connect({ id, name: user.name, avatar: avatarUrl(user) });
    if (user.isAdmin) adminPush();
  });

  socket.on('avatar', (data) => {
    if (!user) return;
    if (data && (typeof data !== 'string' || data.length > MAX_AVATAR || !/^data:image\/(jpeg|png|webp);base64,/.test(data))) {
      return socket.emit('error', 'התמונה גדולה מדי או לא נתמכת');
    }
    auth.setAvatar(user.uid, data || null);
    lobby.setAvatar(playerId, avatarUrl(user));
    lobby.sendMe(playerId);
  });

  // Only the admin adds chips; a member can ask for more.
  socket.on('chipreq', () => {
    if (!user) return;
    const now = Date.now();
    if (user.chipReqAt && now - user.chipReqAt < 60000) return socket.emit('error', 'הבקשה כבר נשלחה למנהל');
    user.chipReqAt = now;
    for (const pid of admins()) for (const sid of socketsOf.get(pid) || []) {
      io.to(sid).emit('admin:chips', { name: user.name, chips: lobby.chips(playerId) });
    }
    adminPush();
    socket.emit('error', 'הבקשה נשלחה למנהל');
  });

  // Private tables are set up by the admin, who sends friends an invite link.
  socket.on('pcreate', (cfg) => {
    if (!user || !user.isAdmin) return socket.emit('error', 'רק המנהל יכול לפתוח שולחן פרטי');
    lobby.createPrivate(playerId, cfg);
  });

  for (const ev of ['join', 'watch', 'leave', 'action', 'back', 'rebuy', 'chat', 'invite', 'tregister', 'tunregister', 'tstart']) {
    socket.on(ev, (data) => { if (playerId) lobby.handle(playerId, ev, data); });
  }

  // ---- admin ----
  socket.on('admin', (msg) => {
    if (!user || !user.isAdmin || !msg) return;
    const { op, uid } = msg;
    if (op === 'approve') {
      const u = auth.approve(uid);
      if (u) for (const s of waiting.get(uid) || []) s.emit('auth', { status: 'approved' });
      waiting.delete(uid);
    } else if (op === 'block') {
      if (auth.block(uid)) {
        for (const s of waiting.get(uid) || []) s.emit('auth', { status: 'blocked' });
        waiting.delete(uid);
        kick(uid);
      }
    } else if (op === 'unblock') auth.unblock(uid);
    else if (op === 'remove') { if (auth.remove(uid)) kick(uid); }
    else if (op === 'chips') {
      const pid = pidOf(uid);
      const amount = Math.max(-1e9, Math.min(1e9, Math.round(Number(msg.amount) || 0)));
      lobby.bankrolls[pid] = Math.max(0, lobby.chips(pid) + amount);
      if (auth.users[uid]) delete auth.users[uid].chipReqAt;
      lobby.save();
      lobby.sendMe(pid);
    }
    adminPush();
  });

  socket.on('disconnect', () => {
    if (!playerId) return;
    const set = socketsOf.get(playerId);
    if (!set) return;
    set.delete(socket.id);
    if (set.size) return;
    // Keep the seat for a minute so a refresh or a flaky phone connection doesn't cost the stack.
    const pid = playerId;
    leaveTimers.set(pid, setTimeout(() => {
      if (!socketsOf.get(pid) || socketsOf.get(pid).size === 0) {
        socketsOf.delete(pid);
        lobby.disconnect(pid);
      }
    }, RECONNECT_GRACE_MS));
  });
});

server.listen(PORT, () => console.log(`Poker server on http://localhost:${PORT}`));
