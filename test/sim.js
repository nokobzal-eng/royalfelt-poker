// Bots-only simulation: checks chip conservation, hand evaluation and that hands keep flowing.
const assert = require('assert');
const E = require('../shared/engine');
const { Lobby } = require('../shared/lobby');

// Evaluator sanity.
const ev = (c) => E.evaluate(c.split(' '));
assert(ev('As Ks Qs Js Ts 2d 3c').name === 'רויאל פלאש');
assert(ev('Ah 2d 3c 4s 5h Kd Kc').cat === 4);
assert(ev('Ah Ad Ac Kd Kc 2s 3s').cat === 6);
assert(ev('Ah Ad Kc Kd 9c 9s 2s').score < ev('Ah Ad Kc Kd 8c 8s Qs').score); // best five: AAKK+Q beats AAKK+9
assert(E.evaluateOmaha('As Ks 2d 3d'.split(' '), 'Qs Js Ts 4c 5h'.split(' ')).cat === 8);
// Omaha must use exactly two hole cards: four spades on board + one in hand is no flush.
assert(E.evaluateOmaha('As Kd 7c 8h'.split(' '), '2s 3s 4s 9s Jd'.split(' ')).cat !== 5);

// Action order: preflop starts left of the big blind, heads-up the button acts first.
{
  const order = (n) => {
    const t = new E.Table({ id: 'x', smallBlind: 1, bigBlind: 2, maxSeats: 6 }, {});
    for (let k = 0; k < n; k++) t.sit({ id: 'p' + k, name: 'p' + k }, k, 200);
    clearTimeout(t.pendingStart); t.pendingStart = null;
    t.startHand(); clearTimeout(t.timer);
    return { t, first: t.toAct };
  };
  let { t, first } = order(3);
  assert.strictEqual(first, t.button, '3-handed: button acts first preflop');
  ({ t, first } = order(2));
  assert.strictEqual(first, t.button, 'heads-up: button/SB acts first preflop');
  ({ t, first } = order(5));
  assert.strictEqual(first, (t.bb + 1) % 6, '5-handed: UTG acts first');
  // Pot limit: SB 1 / BB 2, UTG can raise to at most 7.
  const p = new E.Table({ id: 'y', game: 'PLO4', smallBlind: 1, bigBlind: 2, maxSeats: 6 }, {});
  for (let k = 0; k < 4; k++) p.sit({ id: 'q' + k, name: 'q' + k }, k, 200);
  clearTimeout(p.pendingStart); p.pendingStart = null;
  p.startHand(); clearTimeout(p.timer);
  assert.strictEqual(p.legal(p.toAct).maxRaiseTo, 7);
  assert.strictEqual(p.seats[0].cards.length, 4);
}

const HANDS = +process.argv[2] || 150;
const lobby = new Lobby({ send() {}, tableOpts: { botDelay: [0, 0], nextHandMs: 0, streetMs: 0 } });
const totals = new Map();
const total = (t) => t.seats.reduce((a, s) => a + (s && s.inHand ? s.stack + s.total : 0), 0);
let checks = 0, bounties = 0;
for (const t of lobby.tables.values()) {
  totals.set(t.id, total(t));
  const orig = t.hooks.onHandEnd;
  t.hooks.onHandEnd = (tbl, res) => {
    // Bots get topped up between hands, so compare totals within the hand only.
    const after = total(tbl) - (res.bounty ? res.bounty.amount : 0);
    if (res.bounty) bounties++;
    assert.strictEqual(after, totals.get(tbl.id), `chips leaked on ${tbl.id} hand ${tbl.handNo}`);
    checks++;
    orig(tbl, res);
  };
  const start = t.startHand.bind(t);
  t.startHand = () => { start(); totals.set(t.id, total(t)); };
}
const t0 = Date.now();
const iv = setInterval(() => {
  const hands = [...lobby.tables.values()].map((t) => t.handNo);
  if (hands.every((h) => h >= HANDS) || Date.now() - t0 > 240000) {
    clearInterval(iv);
    for (const t of lobby.tables.values()) {
      const bots = t.seats.filter(Boolean).map((s) => `${s.name}(${s.style}) ${s.stack}`).join(', ');
      console.log(t.id, t.game.code, 'hands', t.handNo, 'avgPot', t.avgPot, '|', bots);
    }
    console.log('bounties won', bounties); console.log('checked', checks, 'hands in', ((Date.now() - t0) / 1000).toFixed(1) + 's');
    assert(hands.every((h) => h >= HANDS), 'tables stalled: ' + hands);
    process.exit(0);
  }
}, 500);
