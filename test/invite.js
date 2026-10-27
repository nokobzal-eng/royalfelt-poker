// Private tables: an invite link still works after the table is gone (server restart or idle close).
const assert = require('assert');
const { Lobby } = require('../shared/lobby');

const errors = [];
const opts = {
  send: (id, ev, data) => { if (ev === 'error') errors.push([id, data]); },
  tableOpts: { botDelay: [0, 0], nextHandMs: 0, streetMs: 0, turnMs: 30 },
};

// The admin opens a table; its invite carries the settings.
let lobby = new Lobby(opts);
const boss = lobby.connect({ id: 'u:boss', name: 'Boss' }).id;
const t = lobby.createPrivate(boss, { name: 'החברים', game: 'PLO5', blinds: 2, maxSeats: 9, bots: 3 });
const view = lobby.tableView(t, boss);
assert.ok(view.private && view.invite, 'table view carries the invite');
const invite = view.invite;
assert.deepStrictEqual(invite, { t: t.code, n: 'החברים', g: 'PLO5', b: 2, s: 9, a: 3 });
for (const tb of lobby.tables.values()) clearTimeout(tb.timer);

// The server restarts: a brand new lobby with no tables.
lobby = new Lobby(opts);
const pal = lobby.connect({ id: 'u:pal', name: 'Pal' }).id;
const boss2 = lobby.connect({ id: 'u:boss', name: 'Boss' }).id;
const cfg = { name: invite.n, game: invite.g, blinds: invite.b, maxSeats: invite.s, bots: invite.a };

lobby.handle(pal, 'invite', { code: invite.t, cfg });
const reopened = [...lobby.tables.values()].find((x) => x.private);
assert.ok(reopened, 'the link reopened the table');
assert.strictEqual(reopened.code, invite.t, 'same code, so the same link keeps working');
assert.strictEqual(reopened.name, 'החברים');
assert.strictEqual(reopened.game.code, 'PLO5');
assert.strictEqual(reopened.maxSeats, 9);
assert.strictEqual(reopened.bigBlind, 100);
assert.strictEqual(lobby.players.get(pal).tableId, reopened.id, 'the friend lands at the table');

// A second friend on the same link joins that table instead of opening another one.
lobby.handle(boss2, 'invite', { code: invite.t, cfg });
assert.strictEqual([...lobby.tables.values()].filter((x) => x.private).length, 1);
assert.strictEqual(lobby.players.get(boss2).tableId, reopened.id);

// Old links without settings still get a clear message, and junk codes open nothing.
lobby.handle(pal, 'invite', { code: 'gone12' });
lobby.handle(pal, 'invite', { code: '../bad', cfg });
assert.strictEqual(errors.length, 2);
assert.strictEqual([...lobby.tables.values()].filter((x) => x.private).length, 1);

console.log('invite: OK (closed table reopened from its link, friends share it)');
process.exit(0);
