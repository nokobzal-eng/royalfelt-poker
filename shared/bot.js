// Poker bot: preflop ranges by position, Monte Carlo equity against modelled
// opponent ranges postflop, pot-odds calls, value/semi-bluff/bluff mixing.
(function (global) {
  'use strict';
  const E = (typeof module === 'object' && module.exports) ? require('./engine') : global.PokerEngine;
  const { RANKS, SUITS, rankVal, handValue } = E;

  const FULL_DECK = [];
  for (const r of RANKS) for (const s of SUITS) FULL_DECK.push(r + s);

  // Bot personalities. aggr scales bluff/raise frequency, loose shifts preflop thresholds.
  const STYLES = {
    TAG: { aggr: 1.0, loose: 0 },
    LAG: { aggr: 1.35, loose: 1 },
    NIT: { aggr: 0.75, loose: -1 },
    PRO: { aggr: 1.15, loose: 0.5 },
  };

  // Chen formula for two-card hands (-1..20).
  function chen(cards) {
    const pts = { 14: 10, 13: 8, 12: 7, 11: 6 };
    let [a, b] = cards.map(rankVal).sort((x, y) => y - x);
    let score = pts[a] || a / 2;
    if (a === b) return Math.max(5, score * 2);
    if (cards[0][1] === cards[1][1]) score += 2;
    const gap = a - b - 1;
    score -= [0, 1, 2, 4][gap] ?? 5;
    if (gap <= 1 && a < 12) score += 1;
    return Math.ceil(score);
  }

  // Rough PLO hand quality: pairs, suitedness, connectedness, high cards.
  function omahaScore(cards) {
    const vals = cards.map(rankVal).sort((a, b) => b - a);
    const suitCount = {};
    for (const c of cards) suitCount[c[1]] = (suitCount[c[1]] || 0) + 1;
    let score = 0;
    const counts = {};
    for (const v of vals) counts[v] = (counts[v] || 0) + 1;
    for (const v in counts) {
      if (counts[v] === 2) score += v >= 10 ? v / 1.5 : v / 3;
      if (counts[v] >= 3) score -= 4; // trips in hand are dead weight
    }
    for (const s in suitCount) {
      if (suitCount[s] >= 2) {
        const high = Math.max(...cards.filter((c) => c[1] === s).map(rankVal));
        score += high === 14 ? 5 : 2.5;
      }
      if (suitCount[s] >= 4) score -= 2;
    }
    const uniq = [...new Set(vals)];
    for (let i = 0; i < uniq.length - 1; i++) {
      const gap = uniq[i] - uniq[i + 1];
      if (gap <= 2) score += 2 - gap * 0.5;
    }
    score += vals.slice(0, 4).reduce((t, v) => t + Math.max(0, v - 9), 0) * 0.6;
    // More hole cards inflate the raw score; shift so thresholds mean the same percentile.
    return score - ({ 4: 0, 5: 1.1, 6: 2.1 }[cards.length] || 0);
  }

  // How tight we assume an opponent's range is, from their actions this hand.
  function rangeFilter(table, opp) {
    const g = table.game;
    if (!opp.pfr && !opp.pfCall) return null;
    if (g.omaha) {
      const thr = opp.pfr ? (table.preflopRaises >= 2 ? 14.5 : 11) : 9;
      return (cards) => omahaScore(cards) >= thr;
    }
    const thr = opp.pfr ? (table.preflopRaises >= 2 ? 10 : 7) : 5;
    return (cards) => chen(cards) >= thr;
  }

  // Monte Carlo equity of `hole` against the live opponents.
  function equity(table, seatIdx, iters, budgetMs) {
    const me = table.seats[seatIdx];
    const g = table.game;
    const board = table.board;
    const opps = table.seats.filter((s, i) => s && i !== seatIdx && s.inHand && !s.folded);
    const filters = opps.map((o) => rangeFilter(table, o));
    const known = new Set(me.cards.concat(board));
    const deck = FULL_DECK.filter((c) => !known.has(c));
    const need = 5 - board.length;
    const t0 = Date.now();
    let win = 0, n = 0;
    const pool = deck.slice();
    for (; n < iters; n++) {
      if ((n & 31) === 0 && Date.now() - t0 > budgetMs) break;
      let len = pool.length;
      // Swap-remove sampling: drawn cards collect at the tail, so len += k puts them back.
      const draw = () => { const j = Math.floor(Math.random() * len); const c = pool[j]; pool[j] = pool[--len]; pool[len] = c; return c; };
      const oppHands = [];
      for (let k = 0; k < opps.length; k++) {
        let hand;
        for (let tries = 0; ; tries++) {
          hand = [];
          for (let h = 0; h < g.hole; h++) hand.push(draw());
          if (!filters[k] || tries >= 4 || filters[k](hand)) break;
          len += g.hole;
        }
        oppHands.push(hand);
      }
      const full = board.slice();
      for (let k = 0; k < need; k++) full.push(draw());
      const mine = handValue(g, me.cards, full).score;
      let best = 0, ties = 0, beaten = false;
      for (const h of oppHands) {
        const s = handValue(g, h, full).score;
        if (s > mine) { beaten = true; break; }
        if (s === mine) ties++;
        if (s > best) best = s;
      }
      if (!beaten) win += 1 / (ties + 1);
    }
    return n ? win / n : 0;
  }

  // Seats left to act after us this street, 0 = button (best position).
  function positionInfo(table, i) {
    const live = [];
    for (let k = 1; k <= table.maxSeats; k++) {
      const j = (table.button + k) % table.maxSeats;
      const s = table.seats[j];
      if (s && s.inHand && !s.folded) live.push(j);
    }
    const idx = live.indexOf(i);
    return { behind: live.length - 1 - idx, players: live.length, isButton: i === table.button, isBB: i === table.bb, isSB: i === table.sb };
  }

  const chance = (p) => Math.random() < p;

  function sizeTo(table, L, potFraction) {
    const pot = L.pot;
    const to = table.currentBet + Math.round((pot + L.toCall) * potFraction);
    return clamp(to, L);
  }
  function clamp(to, L) {
    to = Math.max(L.minRaiseTo, Math.min(to, L.maxRaiseTo));
    // Commit fully when the leftover would be small.
    if (L.maxRaiseTo - to < L.pot * 0.25 && L.maxRaiseTo === L.allInTo) to = L.maxRaiseTo;
    return to;
  }

  function preflopNLH(table, i, L, st) {
    const me = table.seats[i];
    const bb = table.bigBlind;
    const c = chen(me.cards) + st.loose;
    const pos = positionInfo(table, i);
    const stackBB = (me.stack + me.bet) / bb;
    const raises = table.preflopRaises;
    // Opening thresholds: tighter with more players behind.
    const openThr = pos.isButton ? 5 : pos.isSB ? 6 : pos.behind <= 2 ? 6 : pos.behind <= 4 ? 7 : 8;

    if (stackBB <= 15) {
      // Push/fold when short.
      const jamThr = raises ? 9 : openThr - 1;
      if (c >= jamThr) return { type: 'allin' };
      return L.canCheck ? { type: 'check' } : { type: 'fold' };
    }
    if (raises === 0) {
      const limpers = table.seats.filter((s) => s && s.inHand && !s.folded && s.bet === bb && table.seats.indexOf(s) !== table.bb).length;
      if (c >= openThr || (c >= openThr - 1.5 && pos.behind <= 2 && chance(0.3 * st.aggr))) {
        return { type: 'raise', amount: Math.round(bb * (2.5 + limpers + (pos.isSB ? 0.5 : 0))) };
      }
      if (L.canCheck) return { type: 'check' };
      if (pos.isSB && c >= 5) return { type: 'call' };
      return { type: 'fold' };
    }
    const raiseSizeBB = table.currentBet / bb;
    const ip = pos.behind === 0 || pos.isButton;
    if (raises === 1) {
      const bluff3 = ip && c >= 5 && c < 8 && chance(0.1 * st.aggr);
      if (c >= 10 || bluff3) return { type: 'raise', amount: Math.round(table.currentBet * (ip ? 3 : 3.6)) };
      const odds = L.toCall / (L.pot + L.toCall);
      let callThr = ip ? 7 : 8;
      if (pos.isBB) callThr = odds < 0.3 ? 4.5 : 6;
      if (raiseSizeBB > 4) callThr += 1;
      if (c >= callThr) return { type: 'call' };
      return { type: 'fold' };
    }
    // Facing a 3-bet or more.
    if (c >= 12 || (c >= 11 && raises === 2)) {
      return raises >= 3 || stackBB < 60 ? { type: 'allin' } : { type: 'raise', amount: Math.round(table.currentBet * 2.3) };
    }
    if (raises === 2 && c >= 9.5 && L.toCall < me.stack * 0.3) return { type: 'call' };
    if (raises === 2 && ip && c >= 8 && chance(0.15 * st.aggr)) return { type: 'raise', amount: Math.round(table.currentBet * 2.3) };
    return L.canCheck ? { type: 'check' } : { type: 'fold' };
  }

  function preflopOmaha(table, i, L, st) {
    const me = table.seats[i];
    const sc = omahaScore(me.cards) + st.loose * 1.5;
    const pos = positionInfo(table, i);
    const raises = table.preflopRaises;
    const ip = pos.behind === 0 || pos.isButton;
    const openThr = pos.isButton ? 8.6 : pos.behind <= 2 ? 9.8 : 11.7;
    if (raises === 0) {
      if (sc >= openThr) return { type: 'raise', amount: sizeTo(table, L, 1) };
      if (L.canCheck) return { type: 'check' };
      if (pos.isSB && sc >= 9.8) return { type: 'call' };
      return { type: 'fold' };
    }
    if (raises === 1) {
      if (sc >= 14.9 || (ip && sc >= 11.7 && chance(0.15 * st.aggr))) return { type: 'raise', amount: sizeTo(table, L, 1) };
      if (sc >= (pos.isBB ? 8.6 : ip ? 9.8 : 11)) return { type: 'call' };
      return { type: 'fold' };
    }
    if (sc >= 17.7) return { type: 'raise', amount: L.maxRaiseTo };
    if (sc >= 14 && L.toCall < me.stack * 0.35) return { type: 'call' };
    return L.canCheck ? { type: 'check' } : { type: 'fold' };
  }

  function postflop(table, i, L, st) {
    const me = table.seats[i];
    const g = table.game;
    const opps = table.seats.filter((s, j) => s && j !== i && s.inHand && !s.folded);
    const iters = g.omaha ? 260 + 40 * (6 - g.hole) : 700;
    let eq = equity(table, i, iters, 220);
    // Aggression from others this street shifts their range up.
    const aggressors = opps.filter((o) => o.aggrStage === table.stage).length;
    if (aggressors) eq *= Math.pow(g.omaha ? 0.82 : 0.86, aggressors);
    const pos = positionInfo(table, i);
    const river = table.stage === 'river';
    const wasPfAggr = table.preflopAggressor === i;
    const hu = opps.length === 1;
    const valueBar = hu ? 0.62 : 0.55 + 0.08 * opps.length;
    const strongBar = hu ? 0.78 : 0.7 + 0.05 * opps.length;

    if (L.canCheck) {
      if (!L.canRaise) return { type: 'check' };
      if (eq >= strongBar) {
        if (!river && pos.behind > 0 && chance(0.12)) return { type: 'check' }; // trap occasionally
        return { type: 'raise', amount: sizeTo(table, L, river ? 0.8 : 0.7) };
      }
      if (eq >= valueBar) return { type: 'raise', amount: sizeTo(table, L, 0.5) };
      if (table.stage === 'flop' && wasPfAggr && opps.length <= 2 && chance((hu ? 0.6 : 0.35) * st.aggr)) {
        return { type: 'raise', amount: sizeTo(table, L, 0.33) };
      }
      if (!river && eq >= 0.32 && chance(0.35 * st.aggr)) return { type: 'raise', amount: sizeTo(table, L, 0.6) };
      if (river && eq < 0.2 && hu && (wasPfAggr || pos.behind === 0) && chance(0.18 * st.aggr)) {
        return { type: 'raise', amount: sizeTo(table, L, 0.75) };
      }
      return { type: 'check' };
    }

    const odds = L.toCall / (L.pot + L.toCall);
    const implied = river ? 0 : (table.stage === 'flop' ? 0.05 : 0.03);
    const committed = L.toCall >= me.stack * 0.9;
    if (eq >= strongBar + 0.04 && L.canRaise) {
      if (!river && chance(0.25)) return { type: 'call' };
      return { type: 'raise', amount: g.potLimit ? L.maxRaiseTo : clamp(table.currentBet * 3, L) };
    }
    if (eq >= odds - implied + (committed ? 0.03 : 0)) {
      if (!river && L.canRaise && eq > 0.35 && eq < 0.5 && hu && chance(0.1 * st.aggr)) {
        return { type: 'raise', amount: clamp(table.currentBet * 3, L) };
      }
      return { type: 'call' };
    }
    // Rare bluff-raise when folding otherwise.
    if (!river && hu && L.canRaise && table.stage === 'flop' && eq > 0.25 && chance(0.05 * st.aggr)) {
      return { type: 'raise', amount: clamp(table.currentBet * 3, L) };
    }
    return { type: 'fold' };
  }

  function decide(table, i) {
    const s = table.seats[i];
    const st = STYLES[s.style] || STYLES.PRO;
    const L = table.legal(i);
    if (table.stage === 'preflop') {
      return table.game.omaha ? preflopOmaha(table, i, L, st) : preflopNLH(table, i, L, st);
    }
    return postflop(table, i, L, st);
  }

  const api = { decide, chen, omahaScore, equity, STYLES };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else global.PokerBot = api;
})(typeof window !== 'undefined' ? window : globalThis);
