// Texas Hold'em engine: cards, hand evaluation and a table state machine.
// Runs unchanged in Node (require) and in the browser (window.PokerEngine).
(function (global) {
  'use strict';

  const RANKS = '23456789TJQKA';
  const SUITS = 'shdc';
  const HAND_NAMES = ['קלף גבוה', 'זוג', 'שני זוגות', 'שלישייה', 'סטרייט', 'צבע', 'פול האוס', 'רביעייה', 'סטרייט פלאש'];

  function randInt(n) {
    const c = global.crypto;
    if (c && c.getRandomValues) {
      const buf = new Uint32Array(1);
      const limit = Math.floor(0x100000000 / n) * n;
      do { c.getRandomValues(buf); } while (buf[0] >= limit);
      return buf[0] % n;
    }
    return Math.floor(Math.random() * n);
  }

  function newDeck() {
    const d = [];
    for (const r of RANKS) for (const s of SUITS) d.push(r + s);
    for (let i = d.length - 1; i > 0; i--) {
      const j = randInt(i + 1);
      [d[i], d[j]] = [d[j], d[i]];
    }
    return d;
  }

  const rankVal = (c) => RANKS.indexOf(c[0]) + 2;

  // Score a 5-card hand. Higher is better; category = floor(score / 15^5).
  function eval5(cards) {
    const vals = cards.map(rankVal).sort((a, b) => b - a);
    const flush = cards.every((c) => c[1] === cards[0][1]);
    const counts = {};
    for (const v of vals) counts[v] = (counts[v] || 0) + 1;
    const groups = Object.keys(counts).map(Number)
      .sort((a, b) => counts[b] - counts[a] || b - a);
    let straightHigh = 0;
    if (groups.length === 5) {
      if (vals[0] - vals[4] === 4) straightHigh = vals[0];
      else if (vals[0] === 14 && vals[1] === 5) straightHigh = 5;
    }
    let cat, kick;
    const g = groups.map((v) => counts[v]);
    if (straightHigh && flush) { cat = 8; kick = [straightHigh]; }
    else if (g[0] === 4) { cat = 7; kick = groups; }
    else if (g[0] === 3 && g[1] === 2) { cat = 6; kick = groups; }
    else if (flush) { cat = 5; kick = vals; }
    else if (straightHigh) { cat = 4; kick = [straightHigh]; }
    else if (g[0] === 3) { cat = 3; kick = groups; }
    else if (g[0] === 2 && g[1] === 2) { cat = 2; kick = groups; }
    else if (g[0] === 2) { cat = 1; kick = groups; }
    else { cat = 0; kick = vals; }
    let score = cat;
    for (let i = 0; i < 5; i++) score = score * 15 + (kick[i] || 0);
    return score;
  }

  // Best 5 out of 5-7 cards.
  function evaluate(cards) {
    const n = cards.length;
    let best = -1, bestCards = null;
    const pick = [0, 0, 0, 0, 0];
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++)
      for (let d = c + 1; d < n; d++) for (let e = d + 1; e < n; e++) {
        pick[0] = cards[a]; pick[1] = cards[b]; pick[2] = cards[c]; pick[3] = cards[d]; pick[4] = cards[e];
        const s = eval5(pick);
        if (s > best) { best = s; bestCards = pick.slice(); }
      }
    const cat = Math.floor(best / 759375);
    let name = HAND_NAMES[cat];
    if (cat === 8 && best % 759375 >= 14 * 50625) name = 'רויאל פלאש';
    return { score: best, cat, name, cards: bestCards };
  }

  // Omaha: exactly two hole cards plus three board cards.
  function evaluateOmaha(hole, board) {
    let best = null;
    for (let a = 0; a < hole.length; a++) for (let b = a + 1; b < hole.length; b++)
      for (let c = 0; c < board.length; c++) for (let d = c + 1; d < board.length; d++)
        for (let e = d + 1; e < board.length; e++) {
          const five = [hole[a], hole[b], board[c], board[d], board[e]];
          const s = eval5(five);
          if (!best || s > best.score) best = { score: s, cards: five };
        }
    const cat = Math.floor(best.score / 759375);
    let name = HAND_NAMES[cat];
    if (cat === 8 && best.score % 759375 >= 14 * 50625) name = 'רויאל פלאש';
    return { score: best.score, cat, name, cards: best.cards };
  }

  // Game variants: hole cards, betting limit, evaluation rule.
  const GAMES = {
    NLH: { code: 'NLH', label: 'טקסס הולדם', short: 'NLH', hole: 2, potLimit: false, omaha: false },
    PLO4: { code: 'PLO4', label: 'אומהה 4 קלפים', short: 'PLO', hole: 4, potLimit: true, omaha: true },
    PLO5: { code: 'PLO5', label: 'אומהה 5 קלפים', short: 'PLO5', hole: 5, potLimit: true, omaha: true },
    PLO6: { code: 'PLO6', label: 'אומהה 6 קלפים', short: 'PLO6', hole: 6, potLimit: true, omaha: true },
  };

  function handValue(game, hole, board) {
    return game.omaha ? evaluateOmaha(hole, board) : evaluate(hole.concat(board));
  }

  // Mystery Bounty prize tiers, in big blinds, with their odds.
  const BOUNTY_TIERS = [
    { bb: 10, p: 0.5, label: 'ברונזה' },
    { bb: 25, p: 0.28, label: 'כסף' },
    { bb: 50, p: 0.14, label: 'זהב' },
    { bb: 100, p: 0.06, label: 'יהלום' },
    { bb: 500, p: 0.02, label: 'ג\'קפוט' },
  ];

  function drawBountyTier() {
    let r = randInt(10000) / 10000;
    for (const t of BOUNTY_TIERS) { if (r < t.p) return t; r -= t.p; }
    return BOUNTY_TIERS[0];
  }

  class Table {
    // opts: id, name, smallBlind, bigBlind, maxSeats, minBuyIn, maxBuyIn, turnMs
    // hooks: onUpdate(table), onHandEnd(table, result), botDecide(table, seatIdx) -> {type, amount}
    constructor(opts, hooks) {
      this.id = opts.id;
      this.name = opts.name;
      this.smallBlind = opts.smallBlind;
      this.bigBlind = opts.bigBlind;
      this.maxSeats = opts.maxSeats || 6;
      this.game = GAMES[opts.game || 'NLH'];
      this.minBuyIn = opts.minBuyIn || this.bigBlind * 40;
      this.maxBuyIn = opts.maxBuyIn || this.bigBlind * 100;
      this.turnMs = opts.turnMs || 20000;
      this.botDelay = opts.botDelay || [1100, 3600];
      this.nextHandMs = opts.nextHandMs == null ? 4000 : opts.nextHandMs;
      this.streetMs = opts.streetMs == null ? 900 : opts.streetMs;
      this.hooks = hooks || {};
      this.seats = new Array(this.maxSeats).fill(null);
      this.button = -1;
      this.handNo = 0;
      this.stage = 'waiting';
      this.board = [];
      this.log = [];
      this.lastResult = null;
      this.timer = null;
      this.pendingStart = null;
      this.actionSeq = 0;
      this.mysteryBounty = opts.mysteryBounty === true; // off unless a table asks for it
      // Tournaments pay the bounty as a prize outside the chip stacks.
      this.bountyToStack = opts.bountyToStack !== false;
      this.closed = false;
      this.bountyUnit = opts.bountyUnit || 0; // value of one bounty 'big blind'; defaults to the table's big blind
      this.bounty = null; // { id, name, tier, handsLeft }: the amount stays secret until it is won
    }

    // ---- seating ----
    sit(player, seatIdx, buyIn) {
      if (seatIdx == null) seatIdx = this.seats.findIndex((s) => !s);
      if (seatIdx < 0 || seatIdx >= this.maxSeats || this.seats[seatIdx]) return null;
      this.seats[seatIdx] = {
        id: player.id, name: player.name, isBot: !!player.isBot, style: player.style || null, avatar: player.avatar || null,
        stack: buyIn, cards: [], bet: 0, total: 0, inHand: false, folded: false, allIn: false,
        acted: false, lastAction: '', left: false, sitOut: false, showCards: false,
      };
      this.addLog(`${player.name} התיישב עם ${buyIn.toLocaleString()}`);
      this.update();
      this.maybeStart();
      return seatIdx;
    }

    seatOf(id) { return this.seats.findIndex((s) => s && s.id === id && !s.left); }

    // Remove a player. Returns the chips they cash out (stack not committed to the pot).
    leave(id) {
      const i = this.seatOf(id);
      if (i < 0) return 0;
      const p = this.seats[i];
      const cash = p.stack;
      p.stack = 0;
      p.left = true;
      this.addLog(`${p.name} קם מהשולחן`);
      if (this.isActive() && p.inHand && !p.folded) {
        p.folded = true;
        p.foldStage = this.stage;
        p.lastAction = 'פולד';
        this.advance();
      } else if (!p.inHand || !this.isActive()) {
        this.seats[i] = null;
        this.update();
      }
      return cash;
    }

    addChips(id, amount) {
      const i = this.seatOf(id);
      if (i < 0) return false;
      this.seats[i].stack += amount;
      this.update();
      this.maybeStart();
      return true;
    }

    isActive() { return ['preflop', 'flop', 'turn', 'river'].includes(this.stage); }

    playable() {
      return this.seats.map((s, i) => (s && !s.left && !s.sitOut && s.stack > 0 ? i : -1)).filter((i) => i >= 0);
    }

    // New blinds take effect from the next hand.
    setBlinds(sb, bb) { this.smallBlind = sb; this.bigBlind = bb; }

    maybeStart(delay) {
      if (this.isActive() || this.pendingStart || this.closed) return;
      if (this.playable().length < 2) {
        if (this.stage !== 'showdown') this.stage = 'waiting';
        return;
      }
      this.pendingStart = setTimeout(() => { this.pendingStart = null; this.startHand(); }, delay == null ? 1200 : delay);
    }

    nextIdx(from, pred) {
      for (let k = 1; k <= this.maxSeats; k++) {
        const i = (from + k + this.maxSeats) % this.maxSeats;
        if (this.seats[i] && pred(this.seats[i], i)) return i;
      }
      return -1;
    }

    addLog(msg) {
      this.log.push(msg);
      if (this.log.length > 80) this.log.shift();
    }

    update() { if (this.hooks.onUpdate) this.hooks.onUpdate(this); }

    // ---- hand flow ----
    startHand() {
      // Clear seats of players who left during the previous hand.
      this.seats = this.seats.map((s) => (s && s.left ? null : s));
      const players = this.playable();
      if (players.length < 2) { this.stage = 'waiting'; this.update(); return; }
      this.handNo++;
      this.lastResult = null;
      this.deck = newDeck();
      this.board = [];
      for (const s of this.seats) if (s) Object.assign(s, {
        cards: [], bet: 0, total: 0, inHand: false, folded: false, foldStage: null, allIn: false, acted: false, lastAction: '', showCards: false,
        pfr: false, pfCall: false, aggrStage: '',
      });
      for (const i of players) this.seats[i].inHand = true;
      this.button = this.nextIdx(this.button, (s) => s.inHand);
      const headsUp = players.length === 2;
      this.sb = headsUp ? this.button : this.nextIdx(this.button, (s) => s.inHand);
      this.bb = this.nextIdx(this.sb, (s) => s.inHand);
      for (let r = 0; r < this.game.hole; r++) for (let k = 1; k <= this.maxSeats; k++) {
        const s = this.seats[(this.sb - 1 + k + this.maxSeats) % this.maxSeats];
        if (s && s.inHand) s.cards.push(this.deck.pop());
      }
      this.addLog(`— יד #${this.handNo} —`);
      if (this.mysteryBounty) this.moveBounty(players);
      this.post(this.sb, this.smallBlind);
      this.post(this.bb, this.bigBlind);
      this.stage = 'preflop';
      this.currentBet = this.bigBlind;
      this.minRaise = this.bigBlind;
      this.lastRaiser = this.bb;
      // First to act preflop is the player after the big blind (the button/SB heads-up).
      this.toAct = this.nextIdx(this.bb, (s) => s.inHand && !s.allIn);
      this.preflopRaises = 0;
      this.streetAggressor = -1;
      this.preflopAggressor = -1;
      this.advance();
    }

    post(i, amt) {
      const s = this.seats[i];
      const a = Math.min(amt, s.stack);
      s.stack -= a; s.bet += a; s.total += a;
      if (s.stack === 0) s.allIn = true;
    }

    pot() { return this.seats.reduce((t, s) => t + (s ? s.total : 0), 0); }

    legal(i) {
      const s = this.seats[i];
      const toCall = Math.min(this.currentBet - s.bet, s.stack);
      let maxTo = s.bet + s.stack;
      // Pot limit: call, then raise the size of the pot.
      if (this.game.potLimit) maxTo = Math.min(maxTo, Math.max(this.currentBet + this.pot() + (this.currentBet - s.bet), this.currentBet + this.bigBlind));
      const minTo = Math.min(this.currentBet + this.minRaise, maxTo);
      const othersCanAct = this.seats.some((o, j) => j !== i && o && o.inHand && !o.folded && !o.allIn);
      return {
        toCall, canCheck: toCall === 0, minRaiseTo: minTo, maxRaiseTo: maxTo,
        canRaise: maxTo > this.currentBet && othersCanAct, allInTo: s.bet + s.stack,
        pot: this.pot(), currentBet: this.currentBet,
      };
    }

    act(id, type, amount) {
      if (!this.isActive()) return false;
      const i = this.toAct;
      const s = this.seats[i];
      if (!s || s.id !== id) return false;
      const L = this.legal(i);
      const put = (a) => { s.stack -= a; s.bet += a; s.total += a; if (s.stack === 0) s.allIn = true; };
      if (type === 'check' && !L.canCheck) type = 'call';
      if (type === 'call' && L.toCall === 0) type = 'check';
      if (type === 'allin') { type = L.canRaise ? 'raise' : 'call'; amount = L.maxRaiseTo; }
      if (type === 'raise' && !L.canRaise) type = L.toCall ? 'call' : 'check';

      if (type === 'fold') {
        s.folded = true; s.foldStage = this.stage; s.lastAction = 'פולד';
        this.addLog(`${s.name}: פולד`);
      } else if (type === 'check') {
        s.lastAction = 'צ\'ק';
        this.addLog(`${s.name}: צ'ק`);
      } else if (type === 'call') {
        put(L.toCall);
        s.lastAction = s.allIn ? 'אול-אין' : 'קול';
        if (this.stage === 'preflop') s.pfCall = true;
        this.addLog(`${s.name}: קול ${L.toCall.toLocaleString()}`);
      } else if (type === 'raise') {
        let to = Math.round(Number(amount) || 0);
        to = Math.max(L.minRaiseTo, Math.min(to, L.maxRaiseTo));
        const inc = to - this.currentBet;
        put(to - s.bet);
        if (inc >= this.minRaise) this.minRaise = inc;
        const wasBet = this.currentBet === 0;
        this.currentBet = to;
        this.lastRaiser = i;
        this.streetAggressor = i;
        s.aggrStage = this.stage;
        if (this.stage === 'preflop') s.pfr = true;
        if (this.stage === 'preflop') { this.preflopRaises++; this.preflopAggressor = i; }
        for (const o of this.seats) if (o && o !== s) o.acted = false;
        s.lastAction = s.allIn ? 'אול-אין' : (wasBet ? 'בט' : 'רייז');
        this.addLog(`${s.name}: ${s.allIn ? 'אול-אין' : (wasBet ? 'בט' : 'רייז ל־')} ${to.toLocaleString()}`);
      } else return false;
      s.acted = true;
      this.actionSeq++;
      this.advance();
      return true;
    }

    advance() {
      clearTimeout(this.timer);
      const live = this.seats.filter((s) => s && s.inHand && !s.folded);
      if (live.length === 1) return this.finish(live);
      const canAct = live.filter((s) => !s.allIn);
      const done = canAct.length === 0
        || (canAct.length === 1 && canAct[0].bet >= Math.max(...live.map((s) => s.bet)))
        || canAct.every((s) => s.acted && s.bet === this.currentBet);
      if (!done) {
        // Search from toAct inclusive: whoever still owes an action.
        const owes = (s) => s.inHand && !s.folded && !s.allIn && (!s.acted || s.bet < this.currentBet);
        this.toAct = owes(this.seats[this.toAct] || {}) ? this.toAct : this.nextIdx(this.toAct, owes);
        this.startTurn();
        return;
      }
      for (const s of this.seats) if (s) { s.bet = 0; s.acted = false; }
      this.currentBet = 0;
      this.minRaise = this.bigBlind;
      this.streetAggressor = -1;
      this.toAct = -1;
      if (this.stage === 'river') return this.finish(live);
      const runout = canAct.length <= 1;
      this.dealStreet();
      if (runout) {
        this.update();
        this.timer = setTimeout(() => this.advance(), this.streetMs);
        return;
      }
      this.toAct = this.nextIdx(this.button, (s) => s.inHand && !s.folded && !s.allIn);
      this.startTurn();
    }

    dealStreet() {
      this.deck.pop(); // burn
      if (this.stage === 'preflop') { this.board.push(this.deck.pop(), this.deck.pop(), this.deck.pop()); this.stage = 'flop'; }
      else if (this.stage === 'flop') { this.board.push(this.deck.pop()); this.stage = 'turn'; }
      else { this.board.push(this.deck.pop()); this.stage = 'river'; }
      for (const s of this.seats) if (s && !s.folded && !s.allIn) s.lastAction = '';
      this.addLog(`בורד: ${this.board.join(' ')}`);
      // Once everyone left in the hand is all-in, cards go face up.
      const live = this.seats.filter((s) => s && s.inHand && !s.folded);
      if (live.filter((s) => !s.allIn).length <= 1) for (const s of live) s.showCards = true;
    }

    startTurn() {
      const s = this.seats[this.toAct];
      this.deadline = Date.now() + (s.away && !s.isBot ? 1500 : this.turnMs);
      const seq = this.actionSeq, idx = this.toAct, hand = this.handNo;
      this.update();
      const still = () => this.actionSeq === seq && this.toAct === idx && this.handNo === hand && this.isActive();
      if (s.isBot && this.hooks.botDecide) {
        const [lo, hi] = this.botDelay;
        this.timer = setTimeout(() => {
          if (!still()) return;
          let d;
          try { d = this.hooks.botDecide(this, idx); } catch (e) { d = { type: 'check' }; }
          if (!this.act(s.id, d.type, d.amount)) this.act(s.id, 'fold');
        }, lo + Math.random() * (hi - lo));
      } else {
        // A player who timed out is marked away and gets only a short clock until they act again.
        this.timer = setTimeout(() => {
          if (!still()) return;
          const L = this.legal(idx);
          this.act(s.id, L.canCheck ? 'check' : 'fold');
          s.away = true;
        }, s.away ? 1500 : this.turnMs);
      }
    }

    // Split the pot(s) between the remaining players.
    finish(live) {
      clearTimeout(this.timer);
      this.toAct = -1;
      for (const s of this.seats) if (s) s.bet = 0;
      const result = { handNo: this.handNo, winners: [], board: this.board.slice(), shown: [] };
      if (live.length === 1) {
        const w = live[0];
        const amt = this.pot();
        w.stack += amt;
        result.winners.push({ seat: this.seats.indexOf(w), name: w.name, amount: amt, hand: null });
        this.addLog(`${w.name} זוכה ב־${amt.toLocaleString()}`);
      } else {
        const ranks = new Map();
        for (const s of live) {
          ranks.set(s, handValue(this.game, s.cards, this.board));
          s.showCards = true;
          result.shown.push({ seat: this.seats.indexOf(s), cards: s.cards, hand: ranks.get(s).name });
        }
        const contribs = this.seats.filter((s) => s && s.total > 0);
        const levels = [...new Set(live.map((s) => s.total))].sort((a, b) => a - b);
        let prev = 0;
        const won = new Map();
        for (const lvl of levels) {
          let amount = 0;
          for (const s of contribs) amount += Math.max(0, Math.min(s.total, lvl) - prev);
          const eligible = live.filter((s) => s.total >= lvl);
          const top = Math.max(...eligible.map((s) => ranks.get(s).score));
          // Odd chips go to the first winner left of the button.
          const winners = eligible.filter((s) => ranks.get(s).score === top)
            .sort((a, b) => this.distFromButton(a) - this.distFromButton(b));
          const share = Math.floor(amount / winners.length);
          let rem = amount - share * winners.length;
          for (const w of winners) {
            const a = share + (rem-- > 0 ? 1 : 0);
            won.set(w, (won.get(w) || 0) + a);
          }
          prev = lvl;
        }
        // Chips put in beyond the deepest live stack (folded over-calls) return to live winners above.
        for (const [w, amt] of won) {
          w.stack += amt;
          const h = ranks.get(w);
          result.winners.push({ seat: this.seats.indexOf(w), name: w.name, amount: amt, hand: h.name, cat: h.cat, best: h.cards });
          this.addLog(`${w.name} זוכה ב־${amt.toLocaleString()} עם ${h.name}`);
        }
      }
      for (const s of this.seats) if (s) s.total = 0;
      this.stage = 'showdown';
      this.lastResult = result;
      if (this.mysteryBounty) result.bounty = this.claimBounty(live, result);
      if (this.hooks.onHandEnd) this.hooks.onHandEnd(this, result);
      this.update();
      setTimeout(() => {
        if (this.stage !== 'showdown') return;
        for (let i = 0; i < this.maxSeats; i++) if (this.seats[i] && this.seats[i].left) this.seats[i] = null;
        this.stage = 'waiting';
        this.update();
        this.maybeStart(0);
      }, this.nextHandMs);
    }

    // One player per orbit carries a hidden bounty. If it is not won within the orbit, it moves on.
    moveBounty(players) {
      const holder = this.bounty && this.seats.find((s) => s && s.id === this.bounty.id && !s.left && s.inHand);
      if (holder && --this.bounty.handsLeft > 0) return;
      const pool = players.map((i) => this.seats[i]).filter((s) => !holder || s.id !== holder.id);
      const s = pool[randInt(pool.length)];
      this.bounty = { id: s.id, name: s.name, tier: drawBountyTier(), handsLeft: players.length };
      this.addLog(`🎁 מיסטרי באונטי על ${s.name}`);
    }

    // The bounty is won by whoever beats its holder at showdown.
    claimBounty(live, result) {
      if (!this.bounty || live.length < 2) return null;
      const holder = live.find((s) => s.id === this.bounty.id);
      if (!holder || result.winners.some((w) => w.seat === this.seats.indexOf(holder))) return null;
      const top = result.winners.slice().sort((a, b) => b.amount - a.amount)[0];
      const winner = this.seats[top.seat];
      const tier = this.bounty.tier;
      const amount = tier.bb * (this.bountyUnit || this.bigBlind);
      if (this.bountyToStack) winner.stack += amount;
      this.bounty = null;
      this.addLog(`🎁 ${winner.name} זכה במיסטרי באונטי של ${holder.name}: ${amount.toLocaleString()} (${tier.label})`);
      return {
        from: holder.name, fromSeat: this.seats.indexOf(holder), to: winner.name, toSeat: top.seat,
        amount, bb: tier.bb, tier: tier.label, jackpot: tier.bb >= 500,
        tiers: BOUNTY_TIERS.map((t) => t.bb * (this.bountyUnit || this.bigBlind)),
      };
    }

    distFromButton(s) {
      const i = this.seats.indexOf(s);
      return (i - this.button - 1 + this.maxSeats * 2) % this.maxSeats;
    }

    // ---- views ----
    view(viewerId) {
      const me = this.seatOf(viewerId);
      const v = {
        id: this.id, name: this.name, smallBlind: this.smallBlind, bigBlind: this.bigBlind, maxSeats: this.maxSeats,
        game: this.game, minBuyIn: this.minBuyIn, maxBuyIn: this.maxBuyIn, handNo: this.handNo, stage: this.stage,
        board: this.board, pot: this.isActive() || this.stage === 'showdown' ? this.pot() : 0,
        button: this.button, toAct: this.isActive() ? this.toAct : -1, deadline: this.deadline, now: Date.now(), turnMs: this.turnMs,
        mySeat: me, lastResult: this.lastResult, log: this.log.slice(-40),
        bountySeat: this.bounty ? this.seats.findIndex((s) => s && s.id === this.bounty.id) : -1,
        bountyHandsLeft: this.bounty ? this.bounty.handsLeft : 0,
        seats: this.seats.map((s, i) => s && {
          name: s.name, avatar: s.avatar || null, stack: s.stack, bet: s.bet, folded: s.folded, allIn: s.allIn,
          inHand: s.inHand, lastAction: s.lastAction, left: s.left, away: !!s.away,
          // Your own cards stay visible after you fold; other folded hands disappear.
          cards: !s.inHand ? [] : i === me ? s.cards : s.folded ? [] : s.showCards ? s.cards : s.cards.map(() => '??'),
        }),
      };
      if (me >= 0 && this.toAct === me && this.isActive()) v.legal = this.legal(me);
      if (me >= 0 && this.seats[me].inHand && !this.seats[me].folded && this.board.length) {
        v.myHand = handValue(this.game, this.seats[me].cards, this.board).name;
      }
      return v;
    }

    summary() {
      return {
        id: this.id, name: this.name, smallBlind: this.smallBlind, bigBlind: this.bigBlind, maxSeats: this.maxSeats,
        game: this.game.code, gameLabel: this.game.label, minBuyIn: this.minBuyIn, maxBuyIn: this.maxBuyIn,
        players: this.seats.filter((s) => s && !s.left).length,
        avgPot: this.avgPot || 0, handNo: this.handNo, mysteryBounty: this.mysteryBounty,
      };
    }
  }

  const api = { RANKS, SUITS, HAND_NAMES, GAMES, BOUNTY_TIERS, newDeck, eval5, evaluate, evaluateOmaha, handValue, rankVal, randInt, Table };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else global.PokerEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
