// Lobby: players, bankrolls, cash tables, Sit & Go tournaments and house bots.
// Transport-agnostic: the Node server wires it to Socket.IO, offline mode wires it in the browser.
(function (global) {
  'use strict';
  const isNode = typeof module === 'object' && module.exports;
  const E = isNode ? require('./engine') : global.PokerEngine;
  const Bot = isNode ? require('./bot') : global.PokerBot;

  const START_CHIPS = 20000;
  // House players use ordinary nicknames, like anyone else at the table.
  const BOT_NAMES = [
    'dani_k88', 'yossi.tlv', 'MayaB', 'avi777', 'Noam_P', 'roni.ash', 'Tomer91', 'ShiraG', 'eyal_ace', 'BenBaruch',
    'liorz', 'OrenK', 'gal_river', 'idan.s', 'MoshikTLV', 'Yael_H', 'nir_poker', 'amitush', 'Kobi_B', 'Dror77',
    'itay.m', 'Hadas_R', 'Shlomi_G', 'eli.n', 'Ofir23', 'Ziv_K', 'Adi_L', 'Raz_M', 'Gilad.T', 'Omer_88',
    'Snir_B', 'Lihi_P', 'Yarden.k', 'Assaf99', 'Dudu_Hfa', 'Nati.R', 'Yoni_TA', 'Sagi_M', 'Tal_C', 'Erez_88',
    'AceHunter', 'RiverRat', 'NightOwl', 'TheGrinder', 'Maverick', 'IceCold', 'Bishop', 'Ronin',
  ];
  // Knockout jackpot: whoever busts a player gets a prize (cash: big blinds onto the stack, tournament: share of the buy-in).
  const KO_CASH_BB = 20;
  const KO_TOUR_FRAC = 0.5;
  // High-hand bonus: winning at showdown with a straight or better (using your own cards) multiplies what you won.
  // The multiplier is the total, so x2 means an extra pot on top. Cash: onto the stack, capped. Tournament: to the bankroll.
  const HIGH_HAND_MULT = { 4: 2, 5: 3, 6: 5, 7: 10, 8: 15, royal: 20 };
  const HIGH_HAND_CAP_BB = 1000;
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

  const PRIVATE_IDLE_MS = 2 * 60 * 60000; // a private table with no friends seated is closed after two hours
  const BLIND_CHOICES = [[10, 20], [25, 50], [50, 100], [100, 200], [250, 500], [500, 1000]];

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
      this.allowRefill = !!opts.allowRefill; // free bankroll refills (offline demo); online only the admin adds chips
      this.bankrolls = (this.store && this.store.load()) || {};
      this.players = new Map(); // id -> { id, name, tableId }
      this.tables = new Map();
      this.tournaments = new Map();
      this.botSeq = 0;
      this.privSeq = 0;
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
      this.recordStats(t, res);
      this.highHands(t, res);
      this.knockouts(t, res);
      if (t.tournament) return this.onTournamentHand(t.tournament, t, res);
      const total = res.winners.reduce((a, w) => a + w.amount, 0);
      t.potHistory.push(total);
      if (t.potHistory.length > 30) t.potHistory.shift();
      t.avgPot = Math.round(t.potHistory.reduce((a, b) => a + b, 0) / t.potHistory.length);
      setTimeout(() => this.manageBots(t), 500);
      this.broadcastLobby();
    }

    // Hands played and won per player at this table, for the leaderboard beside it.
    recordStats(t, res) {
      t.stats = t.stats || new Map();
      const won = new Set(res.winners.map((w) => w.seat));
      t.seats.forEach((s, i) => {
        if (!s || !s.inHand) return;
        const st = t.stats.get(s.id) || { name: s.name, played: 0, won: 0, best: -1, bestName: '' };
        st.name = s.name;
        st.played++;
        if (won.has(i)) st.won++;
        t.stats.set(s.id, st);
      });
      for (const w of res.winners) {
        const s = t.seats[w.seat];
        const st = s && t.stats.get(s.id);
        if (st && w.cat != null && w.cat > st.best) { st.best = w.cat; st.bestName = w.hand; }
      }
    }

    leaders(t) {
      if (!t.stats) return [];
      return [...t.stats.values()]
        .filter((st) => st.played > 0)
        .map((st) => ({ name: st.name, played: st.played, won: st.won, pct: Math.round((st.won / st.played) * 100), best: st.bestName }))
        .sort((a, b) => (b.pct - a.pct) || (b.won - a.won))
        .slice(0, 10);
    }

    highHands(t, res) {
      if (!res.shown.length) return; // nobody showed: the hand ended with a fold
      const tr = t.tournament;
      for (const w of res.winners) {
        if (w.cat == null || w.cat < 4) continue;
        const s = t.seats[w.seat];
        // Your own cards must play: no bonus when the board alone makes the hand.
        if (!s || !w.best || !w.best.some((c) => s.cards.includes(c))) continue;
        const mult = w.hand === 'רויאל פלאש' ? HIGH_HAND_MULT.royal : HIGH_HAND_MULT[w.cat];
        let extra;
        if (tr) extra = (mult - 1) * Math.round(tr.buyIn / 10);
        else extra = Math.min((mult - 1) * w.amount, HIGH_HAND_CAP_BB * t.bigBlind);
        if (extra <= 0) continue;
        if (tr) {
          if (!s.isBot) { this.bankrolls[s.id] = this.chips(s.id) + extra; this.sendMe(s.id); }
        } else s.stack += extra;
        w.bonus = { mult, amount: extra };
        t.addLog(`⭐ בונוס יד חזקה: ${s.name} עם ${w.hand} מקבל x${mult}, עוד ${extra.toLocaleString()}`);
      }
      this.save();
    }

    // Every player who goes bust pays a jackpot to the biggest winner of that hand.
    knockouts(t, res) {
      const busted = t.seats.filter((s) => s && s.inHand && s.stack === 0);
      if (!busted.length || !res.winners.length) return;
      const top = res.winners.slice().sort((a, b) => b.amount - a.amount)[0];
      const w = t.seats[top.seat];
      if (!w || busted.includes(w)) return;
      const tr = t.tournament;
      for (const b of busted) {
        const amount = tr ? Math.round(tr.buyIn * KO_TOUR_FRAC) : KO_CASH_BB * t.bigBlind;
        if (tr) {
          if (!w.isBot) { this.bankrolls[w.id] = this.chips(w.id) + amount; this.sendMe(w.id); }
        } else w.stack += amount;
        t.addLog(`💥 ג'קפוט נוקאאוט: ${w.name} הוציא את ${b.name} וזכה ב־${amount.toLocaleString()}`);
        this.toTable(t, 'knockout', { to: w.name, toSeat: top.seat, from: b.name, amount, tournament: !!tr });
      }
      this.save();
    }

    // ---- tournaments ----
    tick() {
      if (Date.now() % 60000 < 1000) this.closeIdlePrivate();
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
      const entrants = tr.registered.map((id) => ({ id, name: this.nameOf(id), avatar: (this.players.get(id) || {}).avatar }));
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
          this.send(p.id, 'lobby', this.lobbyView(p.id));
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
      if (profile.avatar !== undefined) p.avatar = profile.avatar || null;
      this.names = this.names || {};
      this.names[id] = name;
      this.save();
      this.sendMe(id);
      const t = p.tableId && this.tables.get(p.tableId);
      if (t) this.send(id, 'table', this.tableView(t, id));
      else this.send(id, 'lobby', this.lobbyView(id));
      return { ok: true, id };
    }

    // url: an image address (or data URL) for the player's picture, null to clear it.
    setAvatar(id, url) {
      const p = this.players.get(id);
      if (p) p.avatar = url || null;
      for (const t of this.tables.values()) {
        const i = t.seatOf(id);
        if (i >= 0) { t.seats[i].avatar = url || null; this.broadcastTable(t); }
      }
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
      if (p) this.send(id, 'me', { id, name: p.name, chips: this.chips(id), tableId: p.tableId, avatar: p.avatar || null });
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
          if (this.allowRefill && this.chips(id) < 2000 && !p.tableId) { this.bankrolls[id] = START_CHIPS; this.save(); }
          return this.sendMe(id);
        }
        case 'invite': return this.acceptInvite(id, data.code);
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

    // cfg: { name, game, blinds (index into BLIND_CHOICES), maxSeats, bots }. Returns the table or an error.
    createPrivate(ownerId, cfg) {
      cfg = cfg || {};
      const game = E.GAMES[cfg.game] ? cfg.game : 'NLH';
      const [sb, bb] = BLIND_CHOICES[Math.max(0, Math.min(BLIND_CHOICES.length - 1, Number(cfg.blinds) || 0))];
      const maxSeats = Number(cfg.maxSeats) === 9 ? 9 : 6;
      const bots = Math.max(0, Math.min(maxSeats - 2, Math.round(Number(cfg.bots) || 0)));
      const name = Lobby.cleanName(cfg.name) || 'השולחן של ' + this.nameOf(ownerId);
      let code;
      do code = Math.random().toString(36).slice(2, 8); while ([...this.tables.values()].some((t) => t.code === code));
      const t = this.createTable({ id: 'p' + (++this.privSeq), name, game, smallBlind: sb, bigBlind: bb, maxSeats, bots });
      t.private = true;
      t.code = code;
      t.owner = ownerId;
      t.members = new Set([ownerId]);
      t.lastHumanAt = Date.now();
      this.watch(ownerId, t.id);
      this.send(ownerId, 'pcreated', { code, name });
      this.broadcastLobby();
      return t;
    }

    acceptInvite(id, code) {
      const t = [...this.tables.values()].find((x) => x.private && x.code === String(code || '').trim());
      if (!t) return this.send(id, 'error', 'השולחן מההזמנה כבר נסגר');
      t.members.add(id);
      this.watch(id, t.id);
    }

    closeIdlePrivate() {
      const now = Date.now();
      for (const t of [...this.tables.values()]) {
        if (!t.private) continue;
        if (t.seats.some((s) => s && !s.isBot && !s.left)) { t.lastHumanAt = now; continue; }
        if (now - t.lastHumanAt < PRIVATE_IDLE_MS) continue;
        if ([...this.players.values()].some((p) => p.tableId === t.id)) continue;
        for (const s of t.seats) if (s && s.isBot) this.usedBotNames.delete(s.name);
        t.closed = true;
        clearTimeout(t.timer);
        this.tables.delete(t.id);
        this.broadcastLobby();
      }
    }

    watch(id, tableId) {
      const p = this.players.get(id);
      const t = this.tables.get(tableId);
      if (!t) return;
      if (t.private && !t.members.has(id)) return this.send(id, 'error', 'שולחן פרטי: צריך הזמנה');
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
      if (t.private && !t.members.has(id)) return this.send(id, 'error', 'שולחן פרטי: צריך הזמנה');
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
      t.sit({ id, name: p.name, avatar: p.avatar }, seat, buyIn);
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
      if (!quiet) this.send(id, 'lobby', this.lobbyView(id));
      this.broadcastLobby();
    }

    // ---- outbound ----
    // A private table only shows up for the friends invited to it.
    lobbyView(id) {
      const visible = (t) => !t.tournament && (!t.private || t.members.has(id));
      return {
        cash: [...this.tables.values()].filter(visible)
          .map((t) => ({ type: 'cash', ...t.summary(), private: !!t.private, code: t.private && t.members.has(id) ? t.code : null }))
          .sort((a, b) => b.private - a.private),
        tournaments: [...this.tournaments.values()].map((tr) => tr.summary()),
      };
    }

    tableView(t, id) {
      const v = t.view(id);
      if (t.tournament) v.tournament = t.tournament.info();
      v.leaders = this.leaders(t);
      if (t.private) { v.private = true; v.code = t.code; }
      return v;
    }

    broadcastLobby() {
      for (const p of this.players.values()) if (!p.tableId) this.send(p.id, 'lobby', this.lobbyView(p.id));
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

  const api = { BLIND_CHOICES, Lobby, Tournament, DEFAULT_TABLES, DEFAULT_TOURNAMENTS, LEVELS, START_CHIPS };
  if (isNode) module.exports = api;
  else global.PokerLobby = api;
})(typeof window !== 'undefined' ? window : globalThis);
