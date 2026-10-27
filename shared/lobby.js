// Lobby: players, bankrolls, cash tables, Sit & Go tournaments and house bots.
// Transport-agnostic: the Node server wires it to Socket.IO, offline mode wires it in the browser.
(function (global) {
  'use strict';
  const isNode = typeof module === 'object' && module.exports;
  const E = isNode ? require('./engine') : global.PokerEngine;
  const Bot = isNode ? require('./bot') : global.PokerBot;

  const START_CHIPS = 20000;
  const BOT_NAMES = [
    'Viper', 'Nitro', 'Shark_IL', 'AceHunter', 'RiverRat', 'IceCold', 'Bluffmaster', 'TheGrinder',
    'Maverick', 'Phantom', 'NightOwl', 'Cobra', 'Hellmuth_Jr', 'Zeus', 'Raptor', 'Solver_X', 'Ghost', 'Titan',
    'DeepStack', 'Kraken', 'Falcon', 'Blade', 'Merlin', 'Oracle',
    'Spartan', 'Wolfpack', 'Joker', 'Vortex', 'Stealth', 'Nomad', 'Bishop', 'Sniper', 'Atlas', 'Rogue', 'Onyx', 'Sphinx',
    'Hydra', 'Panther', 'Diesel', 'Comet', 'Jaguar', 'Saber', 'Tempest', 'Ronin', 'Apex', 'Gambit', 'Maestro', 'Shadow',
  ];
  const STYLE_KEYS = Object.keys(Bot.STYLES);

  const DEFAULT_TABLES = [
    { name: 'Tel Aviv', game: 'NLH', smallBlind: 25, bigBlind: 50, maxSeats: 6, bots: 4 },
    { name: 'Eilat', game: 'NLH', smallBlind: 100, bigBlind: 200, maxSeats: 6, bots: 5 },
    { name: 'Haifa', game: 'NLH', smallBlind: 50, bigBlind: 100, maxSeats: 9, bots: 6 },
    { name: 'Jerusalem', game: 'PLO4', smallBlind: 25, bigBlind: 50, maxSeats: 6, bots: 4 },
    { name: 'Herzliya', game: 'PLO5', smallBlind: 50, bigBlind: 100, maxSeats: 6, bots: 4 },
    { name: 'Netanya', game: 'PLO6', smallBlind: 50, bigBlind: 100, maxSeats: 6, bots: 4 },
  ];

  // Blind levels shared by all Sit & Go's (small blind, big blind).
  const LEVELS = [
    [10, 20], [15, 30], [25, 50], [40, 80], [60, 120], [100, 200], [150, 300], [250, 500],
    [400, 800], [600, 1200], [1000, 2000], [1500, 3000], [2500, 5000], [4000, 8000], [6000, 12000],
  ];

  const DEFAULT_TOURNAMENTS = [
    { name: 'Mystery Bounty Turbo', game: 'NLH', maxSeats: 6, buyIn: 1000, startStack: 3000, levelMin: 3 },
    { name: 'Hyper Sprint', game: 'NLH', maxSeats: 6, buyIn: 500, startStack: 1500, levelMin: 1.5 },
    { name: 'PLO Bounty Turbo', game: 'PLO4', maxSeats: 6, buyIn: 1000, startStack: 3000, levelMin: 3 },
    { name: 'Big Nine Deepstack', game: 'NLH', maxSeats: 9, buyIn: 2000, startStack: 5000, levelMin: 4 },
  ];

  const PAYOUTS = { 6: [0.65, 0.35], 9: [0.5, 0.3, 0.2] };
  const AUTO_START_MS = 60000; // after the first friend registers, bots fill the rest and it starts

  class Tournament {
    constructor(cfg) {
      Object.assign(this, cfg);
      this.levelMs = cfg.levelMs || Math.round(cfg.levelMin * 60000);
      this.payouts = (PAYOUTS[cfg.maxSeats] || PAYOUTS[6]).map((f) => Math.round(f * cfg.buyIn * cfg.maxSeats));
      this.reset();
    }

    reset() {
      this.status = 'registering';
      this.registered = []; // player ids
      this.startAt = 0;
      this.table = null;
      this.results = [];
      this.level = 0;
      this.levelEndsAt = 0;
      this.finishedAt = 0;
    }

    prizePool() { return this.buyIn * this.maxSeats; }

    playersLeft() { return this.table ? this.table.seats.filter((s) => s && s.stack > 0).length : 0; }

    summary() {
      return {
        id: this.id, type: 'tournament', name: this.name, game: this.game, gameLabel: E.GAMES[this.game].label,
        maxSeats: this.maxSeats, buyIn: this.buyIn, startStack: this.startStack, levelMin: this.levelMs / 60000,
        prizePool: this.prizePool(), payouts: this.payouts, status: this.status,
        registered: this.registered.slice(), startsIn: this.startAt ? Math.max(0, this.startAt - Date.now()) : 0,
        level: this.level + 1, blinds: LEVELS[this.level], playersLeft: this.playersLeft(),
        winner: this.results.length && this.status === 'finished' ? this.results[this.results.length - 1].name : null,
      };
    }

    // Extra info shown at the table.
    info() {
      const next = LEVELS[Math.min(this.level + 1, LEVELS.length - 1)];
      return {
        name: this.name, level: this.level + 1, blinds: LEVELS[this.level], next,
        levelLeftMs: Math.max(0, this.levelEndsAt - Date.now()), playersLeft: this.playersLeft(),
        total: this.maxSeats, payouts: this.payouts, status: this.status,
      };
    }
  }

  class Lobby {
    // send(playerId, event, data) delivers to one connected player.
    constructor(opts) {
      this.send = opts.send;
      this.store = opts.store || null; // { load(): {playerId: chips}, save(map) }
      this.tableOpts = opts.tableOpts || {};
      this.bankrolls = (this.store && this.store.load()) || {};
      this.players = new Map(); // id -> { id, name, tableId }
      this.tables = new Map();
      this.tournaments = new Map();
      this.botSeq = 0;
      this.usedBotNames = new Set();
      (opts.tables || DEFAULT_TABLES).forEach((t, k) => this.createTable({ id: 't' + (k + 1), ...t }));
      (opts.tournaments || DEFAULT_TOURNAMENTS).forEach((t, k) => {
        const tr = new Tournament({ id: 's' + (k + 1), ...t, ...(opts.tournamentOpts || {}) });
        this.tournaments.set(tr.id, tr);
      });
      this.ticker = setInterval(() => this.tick(), 1000);
    }

    createTable(cfg) {
      const t = new E.Table({ ...cfg, ...this.tableOpts }, {
        onUpdate: (tbl) => this.broadcastTable(tbl),
        onHandEnd: (tbl, res) => this.onHandEnd(tbl, res),
        botDecide: (tbl, i) => Bot.decide(tbl, i),
      });
      t.botTarget = cfg.bots || 0;
      t.potHistory = [];
      this.tables.set(t.id, t);
      for (let k = 0; k < t.botTarget; k++) this.addBot(t);
      return t;
    }

    botProfile() {
      const free = BOT_NAMES.filter((n) => !this.usedBotNames.has(n));
      const name = free.length ? free[Math.floor(Math.random() * free.length)] : 'Bot' + (++this.botSeq);
      this.usedBotNames.add(name);
      const style = STYLE_KEYS[Math.floor(Math.random() * STYLE_KEYS.length)];
      return { id: 'bot:' + name, name, isBot: true, style };
    }

    addBot(t) { t.sit(this.botProfile(), null, t.maxBuyIn); }

    // Keep bots topped up and make room for humans, but always leave some bots in.
    manageBots(t) {
      if (t.tournament) return;
      for (const s of t.seats) {
        const busy = t.isActive() && s && s.inHand;
        if (s && s.isBot && !s.left && !busy && s.stack < t.bigBlind * 30) s.stack = t.maxBuyIn;
      }
      const bots = t.seats.filter((s) => s && s.isBot && !s.left);
      const humans = t.seats.filter((s) => s && !s.isBot && !s.left).length;
      const free = t.seats.filter((s) => !s).length;
      const wantBots = Math.max(Math.min(2, t.botTarget), Math.min(t.botTarget, t.maxSeats - humans - 1));
      if (bots.length > wantBots && free === 0) {
        const b = bots[bots.length - 1];
        this.usedBotNames.delete(b.name);
        t.leave(b.id);
      } else if (bots.length < wantBots && free > 1) this.addBot(t);
    }

    onHandEnd(t, res) {
      if (t.tournament) return this.onTournamentHand(t.tournament, t, res);
      const total = res.winners.reduce((a, w) => a + w.amount, 0);
      t.potHistory.push(total);
      if (t.potHistory.length > 30) t.potHistory.shift();
      t.avgPot = Math.round(t.potHistory.reduce((a, b) => a + b, 0) / t.potHistory.length);
      setTimeout(() => this.manageBots(t), 500);
      this.broadcastLobby();
    }

    // ---- tournaments ----
    tick() {
      let changed = false;
      for (const tr of this.tournaments.values()) {
        if (tr.status === 'registering' && tr.startAt && Date.now() >= tr.startAt) { this.startTournament(tr); changed = true; }
        if (tr.status === 'running' && Date.now() >= tr.levelEndsAt && tr.level < LEVELS.length - 1) {
          tr.level++;
          tr.levelEndsAt = Date.now() + tr.levelMs;
          const [sb, bb] = LEVELS[tr.level];
          tr.table.setBlinds(sb, bb);
          tr.table.addLog(`⏫ רמה ${tr.level + 1}: בליינדים ${sb}/${bb}`);
          this.toTable(tr.table, 'tlevel', { level: tr.level + 1, sb, bb });
          changed = true;
        }
        if (tr.status === 'registering' && tr.startAt) changed = true; // countdown
      }
      if (changed) this.broadcastLobby();
    }

    tRegister(id, tid) {
      const p = this.players.get(id);
      const tr = this.tournaments.get(tid);
      if (!tr || tr.status !== 'registering') return this.send(id, 'error', 'ההרשמה לטורניר הזה סגורה');
      if (tr.registered.includes(id)) return;
      if (tr.registered.length >= tr.maxSeats) return this.send(id, 'error', 'הטורניר מלא');
      if (this.chips(id) < tr.buyIn) return this.send(id, 'error', 'אין מספיק צ\'יפים לבאי־אין');
      this.bankrolls[id] -= tr.buyIn;
      tr.registered.push(id);
      if (!tr.startAt) tr.startAt = Date.now() + AUTO_START_MS;
      tr.table && tr.table.addLog(`${p.name} נרשם`);
      this.save();
      this.sendMe(id);
      if (tr.registered.length >= tr.maxSeats) this.startTournament(tr);
      this.broadcastLobby();
    }

    tUnregister(id, tid) {
      const tr = this.tournaments.get(tid);
      if (!tr || tr.status !== 'registering' || !tr.registered.includes(id)) return;
      tr.registered = tr.registered.filter((x) => x !== id);
      this.bankrolls[id] += tr.buyIn;
      if (!tr.registered.length) tr.startAt = 0;
      this.save();
      this.sendMe(id);
      this.broadcastLobby();
    }

    tStart(id, tid) {
      const tr = this.tournaments.get(tid);
      if (tr && tr.status === 'registering' && tr.registered.includes(id)) this.startTournament(tr);
    }

    startTournament(tr) {
      const [sb, bb] = LEVELS[0];
      const t = new E.Table({
        id: tr.id, name: tr.name, game: tr.game, smallBlind: sb, bigBlind: bb, maxSeats: tr.maxSeats,
        minBuyIn: 0, maxBuyIn: tr.startStack, mysteryBounty: true, bountyToStack: false,
        bountyUnit: Math.max(1, Math.round(tr.buyIn / 20)), ...this.tableOpts,
      }, {
        onUpdate: (tbl) => this.broadcastTable(tbl),
        onHandEnd: (tbl, res) => this.onHandEnd(tbl, res),
        botDecide: (tbl, i) => Bot.decide(tbl, i),
      });
      t.tournament = tr;
      t.closed = true; // seat everyone first, then deal
      tr.table = t;
      tr.status = 'running';
      tr.level = 0;
      tr.levelEndsAt = Date.now() + tr.levelMs;
      tr.startAt = 0;
      this.tables.set(t.id, t);
      const entrants = tr.registered.map((id) => ({ id, name: this.nameOf(id) }));
      while (entrants.length < tr.maxSeats) entrants.push(this.botProfile());
      // Random seating.
      for (let i = entrants.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [entrants[i], entrants[j]] = [entrants[j], entrants[i]];
      }
      entrants.forEach((e, k) => t.sit(e, k, tr.startStack));
      t.addLog(`🏆 ${tr.name} מתחיל! ${tr.maxSeats} שחקנים, ${tr.startStack.toLocaleString()} צ'יפים לכל אחד`);
      t.closed = false;
      for (const id of tr.registered) {
        const p = this.players.get(id);
        if (!p) continue;
        if (p.tableId && p.tableId !== t.id) this.leaveTable(id, true);
        p.tableId = t.id;
        this.sendMe(id);
        this.send(id, 'tstart', { name: tr.name });
      }
      t.maybeStart(2500);
      this.broadcastTable(t);
      this.broadcastLobby();
    }

    nameOf(id) {
      const p = this.players.get(id);
      return p ? p.name : (this.names && this.names[id]) || 'Player';
    }

    onTournamentHand(tr, t, res) {
      // Mystery Bounty in a tournament is paid out as a cash prize.
      if (res.bounty) {
        const w = t.seats[res.bounty.toSeat];
        if (w && !w.isBot) { this.bankrolls[w.id] = this.chips(w.id) + res.bounty.amount; this.sendMe(w.id); }
      }
      const alive = t.seats.filter((s) => s && s.stack > 0);
      const busted = t.seats.filter((s) => s && s.stack === 0);
      let place = alive.length + busted.length;
      for (const s of busted) {
        this.finishPlace(tr, s, place--);
        t.seats[t.seats.indexOf(s)] = null;
        if (s.isBot) this.usedBotNames.delete(s.name);
      }
      if (alive.length === 1) {
        this.finishPlace(tr, alive[0], 1);
        tr.status = 'finished';
        tr.finishedAt = Date.now();
        t.closed = true;
        t.addLog(`🏆 ${alive[0].name} זוכה ב־${tr.name}!`);
        this.toTable(t, 'twinner', { name: alive[0].name, tournament: tr.name, prize: tr.payouts[0] });
        setTimeout(() => this.resetTournament(tr), 15000);
      }
      this.save();
      this.broadcastLobby();
    }

    finishPlace(tr, s, place) {
      const prize = tr.payouts[place - 1] || 0;
      tr.results.push({ place, name: s.name, prize, isBot: s.isBot });
      t_log(tr, `${s.name} סיים במקום ${place}${prize ? ` וזכה ב־${prize.toLocaleString()}` : ''}`);
      if (s.isBot) return;
      if (prize) this.bankrolls[s.id] = this.chips(s.id) + prize;
      this.send(s.id, 'tresult', { tournament: tr.name, place, of: tr.maxSeats, prize });
      this.sendMe(s.id);
    }

    resetTournament(tr) {
      const t = tr.table;
      if (t) {
        for (const s of t.seats) if (s && s.isBot) this.usedBotNames.delete(s.name);
        this.tables.delete(t.id);
        for (const p of this.players.values()) if (p.tableId === t.id) {
          p.tableId = null;
          this.sendMe(p.id);
          this.send(p.id, 'lobby', this.lobbyView());
        }
      }
      tr.reset();
      this.broadcastLobby();
    }

    // ---- players ----
    static cleanName(raw) { return String(raw || '').trim().replace(/\s+/g, ' ').slice(0, 16); }

    static isBotName(name) { return BOT_NAMES.some((b) => b.toLowerCase() === String(name).toLowerCase()); }

    chips(id) {
      if (this.bankrolls[id] == null) this.bankrolls[id] = START_CHIPS;
      return this.bankrolls[id];
    }

    // profile: { id, name }. The id is stable across reconnects so a player gets their seat back.
    connect(profile) {
      if (typeof profile === 'string') profile = { name: profile };
      const name = Lobby.cleanName(profile.name);
      if (!name) return { error: 'צריך כינוי' };
      if (Lobby.isBotName(name)) return { error: 'הכינוי שמור' };
      const id = profile.id || 'u:' + name;
      this.chips(id);
      if (!this.players.has(id)) this.players.set(id, { id, name, tableId: null });
      const p = this.players.get(id);
      p.name = name;
      this.names = this.names || {};
      this.names[id] = name;
      this.save();
      this.sendMe(id);
      const t = p.tableId && this.tables.get(p.tableId);
      if (t) this.send(id, 'table', this.tableView(t, id));
      else this.send(id, 'lobby', this.lobbyView());
      return { ok: true, id };
    }

    disconnect(id) {
      const p = this.players.get(id);
      if (!p) return;
      this.leaveTable(id, true);
      this.players.delete(id);
      this.broadcastLobby();
    }

    sendMe(id) {
      const p = this.players.get(id);
      if (p) this.send(id, 'me', { id, name: p.name, chips: this.chips(id), tableId: p.tableId });
    }

    save() { if (this.store) this.store.save(this.bankrolls); }

    // ---- actions from clients ----
    handle(id, ev, data) {
      const p = this.players.get(id);
      if (!p) return;
      data = data || {};
      switch (ev) {
        case 'join': return this.joinTable(id, data.tableId, data.buyIn, data.seat);
        case 'watch': return this.watch(id, data.tableId);
        case 'leave': return this.leaveTable(id);
        case 'action': {
          const t = this.tables.get(p.tableId);
          const i = t ? t.seatOf(id) : -1;
          if (i >= 0) { t.seats[i].away = false; t.act(id, data.type, data.amount); }
          return;
        }
        case 'back': { // back from "away"
          const t = this.tables.get(p.tableId);
          const i = t ? t.seatOf(id) : -1;
          if (i >= 0) { t.seats[i].away = false; t.update(); }
          return;
        }
        case 'rebuy': return this.rebuy(id, data.amount);
        case 'refill': {
          if (this.chips(id) < 2000 && !p.tableId) { this.bankrolls[id] = START_CHIPS; this.save(); }
          return this.sendMe(id);
        }
        case 'tregister': return this.tRegister(id, data.id);
        case 'tunregister': return this.tUnregister(id, data.id);
        case 'tstart': return this.tStart(id, data.id);
        case 'chat': {
          const t = this.tables.get(p.tableId);
          const text = String(data.text || '').slice(0, 200).trim();
          if (t && text) this.toTable(t, 'chat', { name: p.name, text });
          return;
        }
      }
    }

    watch(id, tableId) {
      const p = this.players.get(id);
      const t = this.tables.get(tableId);
      if (!t) return;
      if (p.tableId && p.tableId !== tableId) this.leaveTable(id, true);
      p.tableId = tableId;
      const i = t.seatOf(id);
      if (i >= 0) t.seats[i].away = false;
      this.send(id, 'table', this.tableView(t, id));
      this.sendMe(id);
    }

    joinTable(id, tableId, buyIn, seat) {
      const p = this.players.get(id);
      const t = this.tables.get(tableId);
      if (!t) return this.send(id, 'error', 'שולחן לא קיים');
      if (t.tournament) return this.watch(id, tableId);
      if (t.seatOf(id) >= 0) return;
      if (p.tableId && p.tableId !== tableId) this.leaveTable(id, true);
      const bank = this.chips(id);
      buyIn = Math.round(Number(buyIn) || t.maxBuyIn);
      buyIn = Math.max(t.minBuyIn, Math.min(t.maxBuyIn, buyIn, bank));
      if (bank < t.minBuyIn) return this.send(id, 'error', 'אין מספיק צ\'יפים לשולחן הזה');
      // Free a bot seat if the table is full.
      if (!t.seats.some((s) => !s)) {
        const bot = t.seats.find((s) => s && s.isBot && !s.left && !(s.inHand && !s.folded && t.isActive()))
          || t.seats.find((s) => s && s.isBot && !s.left);
        if (!bot) return this.send(id, 'error', 'השולחן מלא');
        this.usedBotNames.delete(bot.name);
        t.leave(bot.id);
        if (!t.seats.some((s) => !s)) return this.send(id, 'error', 'השולחן מלא, נסה שוב בעוד רגע');
      }
      if (seat != null && t.seats[seat]) seat = null;
      this.bankrolls[id] -= buyIn;
      p.tableId = tableId;
      t.sit({ id, name: p.name }, seat, buyIn);
      this.save();
      this.sendMe(id);
      this.broadcastLobby();
      this.manageBots(t);
    }

    rebuy(id, amount) {
      const p = this.players.get(id);
      const t = this.tables.get(p.tableId);
      const i = t ? t.seatOf(id) : -1;
      if (i < 0) return;
      if (t.tournament) return this.send(id, 'error', 'אין ריבאי בטורניר');
      const s = t.seats[i];
      if (t.isActive() && s.inHand) return this.send(id, 'error', 'אפשר להוסיף צ\'יפים בין ידיים');
      const room = t.maxBuyIn - s.stack;
      const add = Math.max(0, Math.min(room, Math.round(Number(amount) || room), this.chips(id)));
      if (!add) return;
      this.bankrolls[id] -= add;
      t.addChips(id, add);
      this.save();
      this.sendMe(id);
    }

    // quiet: don't push the lobby (the caller is about to show something else).
    leaveTable(id, quiet) {
      const p = this.players.get(id);
      if (!p || !p.tableId) return;
      const t = this.tables.get(p.tableId);
      p.tableId = null;
      if (t && t.tournament) {
        // You can't cash out of a tournament: the seat stays and plays on autopilot (check/fold).
        const i = t.seatOf(id);
        if (i >= 0) t.seats[i].away = true;
      } else if (t) {
        this.bankrolls[id] = this.chips(id) + t.leave(id);
        this.save();
        this.manageBots(t);
      }
      this.sendMe(id);
      if (!quiet) this.send(id, 'lobby', this.lobbyView());
      this.broadcastLobby();
    }

    // ---- outbound ----
    lobbyView() {
      return {
        cash: [...this.tables.values()].filter((t) => !t.tournament).map((t) => ({ type: 'cash', ...t.summary() })),
        tournaments: [...this.tournaments.values()].map((tr) => tr.summary()),
      };
    }

    tableView(t, id) {
      const v = t.view(id);
      if (t.tournament) v.tournament = t.tournament.info();
      return v;
    }

    broadcastLobby() {
      const v = this.lobbyView();
      for (const p of this.players.values()) if (!p.tableId) this.send(p.id, 'lobby', v);
    }

    toTable(t, ev, data) {
      for (const p of this.players.values()) if (p.tableId === t.id) this.send(p.id, ev, data);
    }

    broadcastTable(t) {
      for (const p of this.players.values()) if (p.tableId === t.id) this.send(p.id, 'table', this.tableView(t, p.id));
    }

    stop() { clearInterval(this.ticker); }
  }

  function t_log(tr, msg) { if (tr.table) tr.table.addLog(msg); }

  const api = { Lobby, Tournament, DEFAULT_TABLES, DEFAULT_TOURNAMENTS, LEVELS, START_CHIPS };
  if (isNode) module.exports = api;
  else global.PokerLobby = api;
})(typeof window !== 'undefined' ? window : globalThis);
