// Sit & Go: a friend registers, bots fill in, blinds go up, players bust until one wins.
const assert = require('assert');
const { Lobby } = require('../shared/lobby');

const events = [];
const lobby = new Lobby({
  send: (id, ev, data) => { if (ev === 'tresult' || ev === 'twinner') events.push([id, ev, data]); },
  tableOpts: { botDelay: [0, 0], nextHandMs: 0, streetMs: 0, turnMs: 30 },
  tournamentOpts: { levelMs: 1500 },
});
const me = lobby.connect({ id: 'u:test', name: 'Tester' }).id;
const before = lobby.chips(me);
const tr = lobby.tournaments.get('s2');
lobby.handle(me, 'tregister', { id: 's2' });
assert.strictEqual(lobby.chips(me), before - tr.buyIn, 'buy-in taken');
lobby.handle(me, 'tunregister', { id: 's2' });
assert.strictEqual(lobby.chips(me), before, 'unregister refunds');
lobby.handle(me, 'tregister', { id: 's2' });
lobby.handle(me, 'tstart', { id: 's2' });
assert.strictEqual(tr.status, 'running');
assert.strictEqual(tr.table.seats.filter(Boolean).length, tr.maxSeats, 'bots fill the table');

const total = tr.maxSeats * tr.startStack;
const t0 = Date.now();
let maxLevel = 1;
const iv = setInterval(() => {
  if (tr.status === 'running' && !tr.table.isActive()) {
    const chips = tr.table.seats.reduce((a, s) => a + (s ? s.stack : 0), 0);
    assert.strictEqual(chips, total, 'tournament chips are conserved');
  }
  maxLevel = Math.max(maxLevel, tr.level + 1);
  if (tr.status === 'finished' || Date.now() - t0 > 240000) {
    clearInterval(iv);
    lobby.stop();
    assert.strictEqual(tr.status, 'finished', 'tournament finished');
    const places = tr.results.map((r) => r.place).sort((a, b) => a - b);
    assert.deepStrictEqual(places, [1, 2, 3, 4, 5, 6], 'every place given once');
    const mine = events.find((e) => e[1] === 'tresult');
    assert(mine, 'friend got a result');
    const r = tr.results.find((x) => x.name === 'Tester');
    console.log('results', tr.results.map((x) => `${x.place}.${x.name}${x.prize ? ' +' + x.prize : ''}`).join(' '));
    console.log('levels reached', maxLevel, 'hands', tr.table.handNo, 'Tester place', r.place, 'bankroll', lobby.chips(me));
    process.exit(0);
  }
}, 100);
