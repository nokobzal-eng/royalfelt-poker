// Web client: lobby, table rendering and actions. Talks to the server over
// Socket.IO, or runs the whole lobby in the browser when there is no server.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const fmt = (n) => Number(n || 0).toLocaleString('en-US');
  const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' };

  let me = null;          // { id, name, chips, tableId }
  let lobbyData = { cash: [], tournaments: [] };
  let lobbyMode = 'cash';
  let creds = null;       // { name, phone, token, pin } for the online server
  let isAdmin = false;
  let view = null;        // table view from the server
  let localDeadline = 0;
  let filter = 'all';
  let lastTurnKey = '';
  let chatLines = [];

  // ---------- connection ----------
  function storage() {
    try { return window.localStorage; } catch (e) { return null; }
  }

  function makeConn() {
    const online = window.io && !window.__noServer && !params.has('offline');
    if (online) {
      const s = window.io();
      return {
        mode: 'online',
        on: (e, f) => s.on(e, f),
        emit: (e, d) => s.emit(e, d),
        login: (c, cb) => s.emit('login', c, cb),
        onReconnect: (f) => s.io.on('reconnect', f),
      };
    }
    // Offline: the full lobby (tables + bots) runs in this browser tab.
    const handlers = {};
    let myId = null;
    const ls = storage();
    const lobby = new window.PokerLobby.Lobby({
      send(pid, ev, data) {
        if (pid !== myId) return;
        // Copy so the UI never holds live engine objects.
        const copy = JSON.parse(JSON.stringify(data));
        setTimeout(() => (handlers[ev] || []).forEach((f) => f(copy)), 0);
      },
      store: {
        load() { try { return JSON.parse(ls.getItem('rf_bankrolls')) || {}; } catch (e) { return {}; } },
        save(map) { try { ls.setItem('rf_bankrolls', JSON.stringify(map)); } catch (e) { /* storage unavailable */ } },
      },
      allowRefill: true,
    });
    return {
      mode: 'offline',
      on: (e, f) => (handlers[e] = handlers[e] || []).push(f),
      emit(e, d) {
        if (!myId) return;
        if (e === 'pcreate') return lobby.createPrivate(myId, d);
        if (e === 'avatar') { lobby.setAvatar(myId, d); return lobby.sendMe(myId); }
        lobby.handle(myId, e, d);
      },
      login(c, cb) {
        myId = 'u:' + window.PokerLobby.Lobby.cleanName(c.name);
        let avatar = null;
        try { avatar = ls.getItem('rf_avatar'); } catch (e) { /* storage unavailable */ }
        const r = lobby.connect({ id: myId, name: c.name, avatar });
        if (r.error) myId = null;
        cb(r.error ? r : { status: 'approved' });
      },
      onReconnect() {},
    };
  }

  const conn = makeConn();
  if ('serviceWorker' in navigator && conn.mode === 'online') navigator.serviceWorker.register('sw.js').catch(() => {});
  // Sound toggle in the top bar.
  const muteBtn = $('mute');
  const syncMute = () => { muteBtn.textContent = window.FX.isMuted() ? '🔇' : '🔊'; };
  muteBtn.addEventListener('click', () => { window.FX.setMuted(!window.FX.isMuted()); syncMute(); window.FX.play('chip'); });
  syncMute();

  conn.on('me', (m) => {
    me = m;
    renderTop();
    route();
    // Opened from an invite link: go straight to that table.
    const code = load('rf_invite');
    if (code) { keep('rf_invite', ''); conn.emit('invite', { code }); }
  });
  conn.on('lobby', (l) => { lobbyData = l; renderLobby(); });
  conn.on('table', (v) => {
    if (!view || view.id !== v.id) chatLines = [];
    const prev = view;
    view = v;
    if (me && me.tableId === v.id) fresh = tableEvents(prev, v);
    localDeadline = Date.now() + (v.deadline - v.now);
    if (me && me.tableId === v.id) { route(); renderTable(); }
  });
  conn.on('chat', (m) => { chatLines.push(m); if (chatLines.length > 100) chatLines.shift(); renderChat(); });
  conn.on('error', (msg) => toast(typeof msg === 'string' ? msg : 'שגיאת חיבור'));
  conn.onReconnect(() => { if (creds) doLogin(creds); });
  conn.on('auth', (a) => {
    if (a.status === 'approved' && creds) { window.FX.play('win'); doLogin(creds); }
    if (a.status === 'blocked') { me = null; creds = null; show('login'); $('login-err').textContent = 'הגישה שלך נחסמה על ידי המנהל'; }
  });
  conn.on('pcreated', (d) => { window.FX.play('win'); toast(`השולחן "${d.name}" נפתח. לחץ "הזמן חברים" ושלח את הקישור`); });
  conn.on('tstart', (d) => { window.FX.play('allin'); toast(`הטורניר ${d.name} מתחיל! בהצלחה`); });
  conn.on('tlevel', (d) => {
    if (view && view.tournament) window.FX.banner($('table-wrap'), `רמה ${d.level}`, `בליינדים ${fmt(d.sb)}/${fmt(d.bb)}`, '');
    window.FX.play('turn');
  });
  conn.on('twinner', (d) => {
    window.FX.banner($('table-wrap'), '🏆 ' + d.name, `זוכה ב־${d.tournament}!`, 'mega');
    window.FX.confetti($('table-wrap'), 2.5, ['#f2c14e', '#ffe08a', '#fff4c2', '#e0283c']);
    window.FX.play('big');
  });
  conn.on('tresult', (r) => {
    setTimeout(() => {
      $('tres-place').textContent = r.place === 1 ? '🏆' : `#${r.place}`;
      $('tres-text').textContent = r.place === 1 ? `ניצחת ב־${r.tournament} וזכית ב־${fmt(r.prize)}!`
        : `סיימת במקום ${r.place} מתוך ${r.of} ב־${r.tournament}${r.prize ? ` וזכית ב־${fmt(r.prize)}` : ''}.`;
      $('tres').classList.remove('hidden');
      if (r.prize) { window.FX.play('big'); window.FX.confetti(document.body.querySelector('#tres .modal-card'), 1); }
    }, r.place === 1 ? 2500 : 1200);
  });
  $('tres-ok').addEventListener('click', () => { $('tres').classList.add('hidden'); if (me && me.tableId && view && view.tournament && view.tournament.status === 'finished') conn.emit('leave'); });

  // ---------- login ----------
  const online = conn.mode === 'online';
  const load = (k) => { try { return storage().getItem(k); } catch (e) { return null; } };
  const keep = (k, v) => { try { storage().setItem(k, v); } catch (e) { /* storage unavailable */ } };
  if (params.get('t')) {
    keep('rf_invite', params.get('t'));
    history.replaceState(null, '', location.pathname);
  }
  if (!online) {
    $('login-phone').classList.add('hidden');
    $('login-note').classList.add('hidden');
  } else {
    $('login-phone').required = true;
    $('pin-toggle').classList.remove('hidden');
  }
  $('pin-toggle').addEventListener('click', () => $('login-pin').classList.toggle('hidden'));
  if (load('rf_name')) $('login-name').value = load('rf_name');
  if (load('rf_phone')) $('login-phone').value = load('rf_phone');

  function doLogin(c) {
    creds = c;
    conn.login(c, (r) => {
      if (r.error) { show('login'); $('login-err').textContent = r.error; return; }
      if (r.token) { creds.token = r.token; keep('rf_token', r.token); }
      $('pin-form').classList.add('hidden');
      if (r.status === 'needpin') {
        $('pending-text').textContent = r.wrongPin ? 'הקוד שגוי. נסה שוב.'
          : 'זה מספר המנהל, ממכשיר או דפדפן חדש. הכנס את קוד המנהל שהגדרת ב־Render (ADMIN_PIN).';
        $('pin-form').classList.remove('hidden');
        return show('pending');
      }
      if (r.status === 'pending') {
        $('pending-text').textContent = r.newDevice
          ? 'נכנסת ממכשיר חדש. המנהל צריך לאשר אותו, והדף ייכנס אוטומטית ברגע שיאושר.'
          : 'המנהל צריך לאשר את הכניסה שלך. הדף ייכנס אוטומטית ברגע שתאושר.';
        return show('pending');
      }
      if (r.status === 'blocked') { show('login'); $('login-err').textContent = 'הגישה שלך חסומה'; return; }
      isAdmin = !!r.isAdmin;
      $('admin-btn').classList.toggle('hidden', !isAdmin);
      if (me) renderTop();
      $('login-err').textContent = '';
    });
  }

  $('login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    window.FX.play('chip'); // unlocks audio on the first tap
    const name = $('login-name').value.trim();
    const phone = $('login-phone').value.trim();
    keep('rf_name', name);
    keep('rf_phone', phone);
    doLogin({ name, phone, token: load('rf_token'), pin: $('login-pin').value || undefined });
  });
  $('pin-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (creds) doLogin({ ...creds, pin: $('pending-pin').value });
  });
  $('pending-back').addEventListener('click', () => { creds = null; show('login'); });
  // Members who were approved before go straight in.
  if (online && load('rf_token') && load('rf_name') && load('rf_phone')) {
    doLogin({ name: load('rf_name'), phone: load('rf_phone'), token: load('rf_token') });
  }

  function show(id) {
    for (const s of ['login', 'pending', 'lobby', 'table-screen']) $(s).classList.toggle('hidden', s !== id);
  }

  function route() {
    if (!me) return;
    if (me.tableId && view && view.id === me.tableId) {
      // The table can arrive just before we learn we sit there: draw it now.
      if ($('table-screen').classList.contains('hidden')) renderTable();
      show('table-screen');
    }
    else if (!me.tableId) show('lobby');
  }

  function renderTop() {
    $('wallet').classList.toggle('hidden', !me);
    $('wallet-amt').textContent = fmt(me && me.chips);
    $('me-name').textContent = me ? me.name : '';
    $('me-pic').classList.toggle('hidden', !me);
    if (me) $('me-pic').innerHTML = avatarHtml(me.name, me.avatar);
    $('pcreate-btn').classList.toggle('hidden', !me || (online && !isAdmin));
    $('refill').textContent = online ? 'בקש צ\'יפים מהמנהל' : 'מלא מחדש את הקופה';
    $('refill').classList.toggle('hidden', !me || me.chips >= 2000);
  }

  // ---------- lobby ----------
  $('game-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    filter = b.dataset.f;
    [...$('game-tabs').children].forEach((x) => x.classList.toggle('active', x === b));
    renderLobby();
  });
  $('refill').addEventListener('click', () => conn.emit(online ? 'chipreq' : 'refill'));

  // ---------- profile picture ----------
  $('me-pic').addEventListener('click', () => $('pic-input').click());
  $('pic-input').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f || !/^image\//.test(f.type)) return;
    const img = new Image();
    const url = URL.createObjectURL(f);
    img.onload = () => {
      // Center-crop to a square and shrink, so it stays small enough to send.
      const S = 160, c = document.createElement('canvas');
      c.width = c.height = S;
      const side = Math.min(img.width, img.height);
      c.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, S, S);
      URL.revokeObjectURL(url);
      const data = c.toDataURL('image/jpeg', 0.82);
      if (!online) keep('rf_avatar', data);
      conn.emit('avatar', data);
      toast('התמונה עודכנה');
    };
    img.onerror = () => { URL.revokeObjectURL(url); toast('לא הצלחתי לקרוא את התמונה'); };
    img.src = url;
  });

  $('mode-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    lobbyMode = b.dataset.m;
    [...$('mode-tabs').children].forEach((x) => x.classList.toggle('active', x === b));
    renderLobby();
  });

  function renderLobby() {
    $('table-list').classList.toggle('hidden', lobbyMode !== 'cash');
    $('tour-list').classList.toggle('hidden', lobbyMode !== 'tour');
    const rows = lobbyData.cash.filter((t) => filter === 'all' || t.game === filter);
    $('table-list').innerHTML = rows.map((t) => {
      const bar = Array.from({ length: t.maxSeats }, (_, i) => `<i class="${i < t.players ? 'human' : ''}"></i>`).join('');
      return `<div class="trow${t.private ? ' private' : ''}">
        <div class="trow-top"><span class="tname">${t.private ? '🔒 ' : ''}${esc(t.name)}</span><span class="gtag ${t.game}">${t.gameLabel}</span></div>
        <div class="tstats">
          <div>בלינדים<b>${fmt(t.smallBlind)}/${fmt(t.bigBlind)}</b></div>
          <div>שחקנים<b>${t.players}/${t.maxSeats}</b></div>
          <div>קופה ממוצעת<b>${fmt(t.avgPot)}</b></div>
        </div>
        <div class="seatbar">${bar}</div>
        <div class="muted small">באי־אין ${fmt(t.minBuyIn)}–${fmt(t.maxBuyIn)} · 🎰 ג'קפוט על רביעייה ומעלה</div>
        <div class="trow-actions">
          ${t.code ? `<button class="btn btn-ghost" data-invite="${t.code}" data-iname="${esc(t.name)}">📨 הזמן</button>` : ''}
          <button class="btn btn-ghost" data-watch="${t.id}">צפה</button>
          <button class="btn btn-primary" data-join="${t.id}">שב לשחק</button>
        </div>
      </div>`;
    }).join('');
    $('tour-list').innerHTML = lobbyData.tournaments.filter((t) => filter === 'all' || t.game === filter).map(tourCard).join('');
  }

  function tourCard(t) {
    const mine = me && t.registered.includes(me.id);
    const status = {
      registering: t.registered.length
        ? `נרשמו ${t.registered.length}/${t.maxSeats} · מתחיל בעוד ${Math.ceil(t.startsIn / 1000)} שנ' (בוטים משלימים)`
        : 'פתוח להרשמה',
      running: `רץ עכשיו · רמה ${t.level} (${fmt(t.blinds[0])}/${fmt(t.blinds[1])}) · נשארו ${t.playersLeft}`,
      finished: t.winner ? `הסתיים · זוכה: ${esc(t.winner)}` : 'הסתיים',
    }[t.status];
    let actions = '';
    if (t.status === 'registering') {
      actions = mine
        ? `<button class="btn btn-ghost" data-tunreg="${t.id}">בטל הרשמה</button><button class="btn btn-primary" data-tstart="${t.id}">התחל עכשיו</button>`
        : `<button class="btn btn-primary" data-treg="${t.id}">הרשמה · ${fmt(t.buyIn)}</button>`;
    } else if (t.status === 'running') {
      actions = `<button class="btn ${mine ? 'btn-primary' : 'btn-ghost'}" data-watch="${t.id}">${mine ? 'חזור לשולחן' : 'צפה'}</button>`;
    }
    const pays = t.payouts.map((p, i) => `${['🥇', '🥈', '🥉'][i]} ${fmt(p)}`).join(' · ');
    return `<div class="trow tour ${t.status}">
      <div class="trow-top"><span class="tname">🏆 ${esc(t.name)}</span><span class="gtag ${t.game}">${t.gameLabel}</span></div>
      <div class="tstats">
        <div>באי־אין<b>${fmt(t.buyIn)}</b></div>
        <div>פרסים<b>${fmt(t.prizePool)}</b></div>
        <div>סטאק<b>${fmt(t.startStack)}</b></div>
      </div>
      <div class="muted small">${pays}</div>
      <div class="muted small">${t.maxSeats} שחקנים · בליינדים עולים כל ${t.levelMin} דק'</div>
      <div class="tour-status ${t.status}">${status}</div>
      <div class="trow-actions">${actions}</div>
    </div>`;
  }

  function lobbyClick(e) {
    const j = e.target.closest('[data-join]');
    const w = e.target.closest('[data-watch]');
    const r = e.target.closest('[data-treg]');
    const u = e.target.closest('[data-tunreg]');
    const st = e.target.closest('[data-tstart]');
    const inv = e.target.closest('[data-invite]');
    if (inv) return shareInvite(inv.dataset.invite, inv.dataset.iname);
    if (w) conn.emit('watch', { tableId: w.dataset.watch });
    if (r) { window.FX.play('chip'); conn.emit('tregister', { id: r.dataset.treg }); }
    if (u) conn.emit('tunregister', { id: u.dataset.tunreg });
    if (st) conn.emit('tstart', { id: st.dataset.tstart });
    if (j) buyInModal(lobbyData.cash.find((x) => x.id === j.dataset.join), null);
  }
  $('table-list').addEventListener('click', lobbyClick);
  $('tour-list').addEventListener('click', lobbyClick);

  // ---------- private tables ----------
  $('p-blinds').innerHTML = window.PokerLobby.BLIND_CHOICES.map(([sb, bb], k) =>
    `<option value="${k}"${k === 1 ? ' selected' : ''}>${fmt(sb)}/${fmt(bb)}</option>`).join('');
  $('pcreate-btn').addEventListener('click', () => $('pmodal').classList.remove('hidden'));
  $('p-cancel').addEventListener('click', () => $('pmodal').classList.add('hidden'));
  $('pform').addEventListener('submit', (e) => {
    e.preventDefault();
    $('pmodal').classList.add('hidden');
    conn.emit('pcreate', {
      name: $('p-name').value, game: $('p-game').value, blinds: Number($('p-blinds').value),
      maxSeats: Number($('p-seats').value), bots: Number($('p-bots').value),
    });
  });
  $('invite-btn').addEventListener('click', () => view && view.code && shareInvite(view.code, view.name));

  // Phones open the share sheet (WhatsApp etc.); elsewhere the link is copied.
  async function shareInvite(code, name) {
    const url = `${location.origin}${location.pathname}?t=${code}`;
    const text = `בוא לשחק איתי פוקר בשולחן "${name}" 🃏`;
    if (navigator.share) {
      try { await navigator.share({ title: 'RoyalFelt Poker', text, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    try { await navigator.clipboard.writeText(`${text}\n${url}`); toast('קישור ההזמנה הועתק. הדבק אותו בוואטסאפ'); } catch (e) { prompt('העתק את קישור ההזמנה:', url); }
  }

  // ---------- install as an app ----------
  // Android/Chrome: a real install prompt. iPhone: Safari can only add to the home screen by hand, so show the steps.
  const ua = navigator.userAgent;
  const isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const inAppBrowser = /WhatsApp|FBAN|FBAV|Instagram|Line\//.test(ua);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const isPhone = isIOS || /Android/.test(ua);
  let installEvent = null;
  const showInstall = (on) => document.querySelectorAll('[data-install]').forEach((b) => b.classList.toggle('hidden', !on));
  showInstall(online && !standalone && isPhone);
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; if (!standalone) showInstall(true); });
  window.addEventListener('appinstalled', () => { showInstall(false); toast('האפליקציה הותקנה! אפשר לפתוח אותה מהמסך הראשי'); });
  function installHelp(html) { $('install-steps').innerHTML = html; $('install-help').classList.remove('hidden'); }
  $('install-close').addEventListener('click', () => $('install-help').classList.add('hidden'));
  document.querySelectorAll('[data-install]').forEach((b) => b.addEventListener('click', async () => {
    if (installEvent) {
      installEvent.prompt();
      const r = await installEvent.userChoice.catch(() => null);
      if (r && r.outcome === 'accepted') showInstall(false);
      installEvent = null;
      return;
    }
    if (inAppBrowser) {
      return installHelp(`<p>הקישור נפתח בתוך וואטסאפ, ומשם אי אפשר להתקין.</p><ol>
        <li>לחץ על <b>⋮</b> (או ⋯) למעלה</li><li>בחר <b>${isIOS ? 'פתח בספארי' : 'פתח בכרום'}</b></li>
        <li>בדף שנפתח לחץ שוב על "התקן אפליקציה"</li></ol>`);
    }
    if (isIOS) {
      return installHelp(`<ol><li>פתח את האתר ב<b>ספארי</b></li>
        <li>לחץ על כפתור השיתוף <b>⬆️</b> בתחתית המסך</li>
        <li>גלול ובחר <b>"הוסף למסך הבית"</b></li><li>לחץ <b>"הוסף"</b>. האייקון ♠ יופיע במסך הבית</li></ol>`);
    }
    installHelp(`<ol><li>פתח את האתר ב<b>כרום</b></li><li>לחץ על <b>⋮</b> למעלה מימין</li>
      <li>בחר <b>"התקנת אפליקציה"</b> או <b>"הוספה למסך הבית"</b></li></ol>`);
  }));

  // ---------- buy-in / rebuy modal ----------
  let modalOk = null;
  function openModal(title, min, max, def, ok) {
    if (max < min) return toast('אין מספיק צ\'יפים');
    $('modal-title').textContent = title;
    const r = $('buyin-range'), n = $('buyin-num');
    r.min = n.min = min; r.max = n.max = max; r.step = 1;
    r.value = n.value = Math.max(min, Math.min(max, def));
    $('buyin-limits').textContent = `מינימום ${fmt(min)} · מקסימום ${fmt(max)}`;
    modalOk = ok;
    $('modal').classList.remove('hidden');
  }
  $('buyin-range').addEventListener('input', (e) => { $('buyin-num').value = e.target.value; });
  $('buyin-num').addEventListener('input', (e) => { $('buyin-range').value = e.target.value; });
  $('modal-cancel').addEventListener('click', () => $('modal').classList.add('hidden'));
  $('modal-ok').addEventListener('click', () => {
    $('modal').classList.add('hidden');
    if (modalOk) modalOk(Number($('buyin-num').value));
  });

  function buyInModal(t, seat) {
    openModal(`באי־אין ל${t.name}`, t.minBuyIn, Math.min(t.maxBuyIn, me.chips), t.maxBuyIn,
      (amt) => conn.emit('join', { tableId: t.id, buyIn: amt, seat }));
  }

  // ---------- table ----------
  $('back').addEventListener('click', () => conn.emit('leave'));
  $('sit').addEventListener('click', () => view && buyInModal(view, null));
  $('rebuy').addEventListener('click', () => {
    if (!view || view.mySeat < 0) return;
    const s = view.seats[view.mySeat];
    const room = view.maxBuyIn - s.stack;
    if (room <= 0) return toast('אתה כבר במקסימום');
    openModal('הוספת צ\'יפים', 1, Math.min(room, me.chips), room, (amt) => conn.emit('rebuy', { amount: amt }));
  });

  function seatPos(rel, n) {
    const mobile = window.matchMedia('(max-width: 900px)').matches;
    const a = Math.PI / 2 + (rel * 2 * Math.PI) / n;
    const rx = mobile ? 40 : 42, ry = mobile ? 41 : 39;
    return { x: 50 + rx * Math.cos(a), y: 50 + ry * Math.sin(a) };
  }

  // Seat, bet and center positions in % of the table, from this viewer's perspective.
  function seatAt(v, i) {
    const pivot = v.mySeat >= 0 ? v.mySeat : 0;
    return seatPos((i - pivot + v.maxSeats) % v.maxSeats, v.maxSeats);
  }
  const betAt = (p) => ({ x: 50 + (p.x - 50) * 0.52, y: 50 + (p.y - 50) * 0.5 });
  const CENTER = { x: 50, y: 46 };

  // One-shot render hints from the last update: which cards just arrived, which tags just changed.
  let fresh = { hole: false, boardFrom: 99, tags: new Set() };

  function actionSound(a) {
    if (/פולד/.test(a)) return 'fold';
    if (/צ'ק/.test(a)) return 'check';
    if (/אול/.test(a)) return 'allin';
    return 'chip';
  }

  // Compare the previous and the new table state and fire sounds and effects.
  function tableEvents(prev, v) {
    const out = { hole: false, boardFrom: 99, tags: new Set() };
    const wrap = $('table-wrap');
    const same = prev && prev.id === v.id;
    const sameHand = same && prev.handNo === v.handNo;
    if (!sameHand && v.stage === 'preflop') {
      out.hole = true;
      const n = Math.min(12, v.seats.filter((s) => s && s.inHand).length * 2);
      for (let k = 0; k < n; k++) window.FX.play('deal', k * 0.06);
    }
    if (sameHand && v.board.length > prev.board.length) {
      out.boardFrom = prev.board.length;
      for (let k = prev.board.length; k < v.board.length; k++) window.FX.play('deal', (k - prev.board.length) * 0.12);
    }
    if (sameHand) {
      v.seats.forEach((s, i) => {
        const p = prev.seats[i];
        if (!s || !p || s.name !== p.name) return;
        if (s.lastAction && s.lastAction !== p.lastAction) {
          out.tags.add(i);
          window.FX.play(actionSound(s.lastAction));
        }
        if (s.bet > p.bet) window.FX.flyChips(wrap, seatAt(v, i), betAt(seatAt(v, i)), 3);
      });
    }
    const res = v.lastResult;
    if (v.stage === 'showdown' && res && !(same && prev.stage === 'showdown' && prev.handNo === v.handNo)) {
      res.winners.forEach((w, k) => window.FX.flyChips(wrap, CENTER, seatAt(v, w.seat), 6, k * 250));
      const top = res.winners.reduce((a, w) => ((w.cat || 0) > (a.cat || 0) ? w : a), res.winners[0] || {});
      const iWon = res.winners.some((w) => w.seat === v.mySeat);
      if (top && top.cat >= 4) {
        // A strong hand: banner, fanfare and confetti, bigger for full house and up.
        window.FX.banner(wrap, top.hand + '!', `${top.name} +${fmt(top.amount)}`, top.cat >= 7 ? 'mega' : top.cat >= 6 ? 'big' : '');
        window.FX.play(top.cat >= 6 ? 'big' : 'win');
        window.FX.confetti(wrap, top.cat >= 7 ? 2.2 : top.cat >= 6 ? 1.5 : 1);
      } else if (iWon) window.FX.play('win');
      const jp = res.winners.find((w) => w.jackpot);
      const bonus = !jp && res.winners.find((w) => w.bonus);
      if (jp) {
        setTimeout(() => {
          window.FX.banner(wrap, '🎰 ג\'קפוט!', `${jp.name} · ${jp.jackpot.label} · +${fmt(jp.jackpot.amount + jp.bonus.amount)}`, 'mega');
          window.FX.confetti(wrap, 3, ['#f2c14e', '#ffe08a', '#fff4c2', '#e0283c', '#7ee0a1']);
          window.FX.play('big');
          setTimeout(() => window.FX.confetti(wrap, 2.5), 900);
        }, 2000);
      }
      if (bonus) {
        setTimeout(() => {
          window.FX.banner(wrap, `⭐ בונוס x${bonus.bonus.mult}`, `${bonus.name} · ${bonus.hand} · +${fmt(bonus.bonus.amount)}`, bonus.bonus.mult >= 10 ? 'mega' : 'big');
          window.FX.confetti(wrap, bonus.bonus.mult >= 10 ? 2.4 : 1.6, ['#f2c14e', '#ffe08a', '#fff4c2', '#7ee0a1']);
          window.FX.play('big');
        }, 2000);
      }
    }
    return out;
  }

  function avatarHtml(name, avatar) {
    if (avatar) return `<div class="avatar pic"><img src="${esc(avatar)}" alt=""></div>`;
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return `<div class="avatar" style="--hue:${h}">${esc(name[0].toUpperCase())}</div>`;
  }

  function cardHtml(c, cls) {
    if (c === '??') return `<div class="card back ${cls || ''}"></div>`;
    const r = c[0] === 'T' ? '10' : c[0];
    return `<div class="card ${c[1]} ${cls || ''}"><span class="r">${r}</span><span class="su">${SUIT[c[1]]}</span></div>`;
  }

  function renderTable() {
    const v = view;
    const n = v.maxSeats;
    const pivot = v.mySeat >= 0 ? v.mySeat : 0;
    const showdown = v.stage === 'showdown' && v.lastResult;
    const winners = new Set(showdown ? v.lastResult.winners.map((w) => w.seat) : []);
    const best = new Set(showdown && v.lastResult.winners[0] && v.lastResult.winners[0].best || []);

    $('table-title').innerHTML = `${esc(v.name)}<span>${v.game.label} · ${fmt(v.smallBlind)}/${fmt(v.bigBlind)} · יד #${v.handNo}</span>`;
    const tr = v.tournament;
    $('sit').classList.toggle('hidden', v.mySeat >= 0 || !!tr);
    $('rebuy').classList.toggle('hidden', v.mySeat < 0 || !!tr);
    $('invite-btn').classList.toggle('hidden', !v.private);
    $('tour-hud').classList.toggle('hidden', !tr);
    if (tr) {
      tourHudUntil = Date.now() + tr.levelLeftMs;
      $('tour-hud').innerHTML = `<b>🏆 ${esc(tr.name)}</b><span>רמה ${tr.level} · ${fmt(tr.blinds[0])}/${fmt(tr.blinds[1])}</span>`
        + `<span>הבאה ${fmt(tr.next[0])}/${fmt(tr.next[1])} בעוד <i data-level-clock></i></span><span>נשארו ${tr.playersLeft}/${tr.total}</span>`;
    }

    $('pot').textContent = v.pot ? `קופה: ${fmt(v.pot)}` : '';
    $('board').innerHTML = v.board.map((c, k) => cardHtml(c, (best.size ? (best.has(c) ? 'win' : 'dim') : '')
      + (k >= fresh.boardFrom ? ` deal-in d${k - fresh.boardFrom}` : ''))).join('');

    let info = '';
    if (showdown) {
      info = v.lastResult.winners.map((w) => `${esc(w.name)} זוכה ב־${fmt(w.amount)}${w.hand ? ' עם ' + w.hand : ''}`).join(' · ');
    } else if (v.myHand) info = `היד שלך: ${v.myHand}`;
    else if (v.stage === 'waiting') info = 'ממתינים לשחקנים...';
    $('hand-info').textContent = info;

    let html = '';
    for (let i = 0; i < n; i++) {
      const rel = (i - pivot + n) % n;
      const p = seatPos(rel, n);
      const s = v.seats[i];
      if (!s) {
        if (v.mySeat < 0) html += `<button class="empty-seat" data-seat="${i}" style="left:${p.x}%;top:${p.y}%">שב כאן</button>`;
        continue;
      }
      const cls = ['seat'];
      if (i === v.mySeat) cls.push('me');
      if (i === v.toAct) cls.push('turn');
      if (s.folded || s.left) cls.push('folded');
      if (winners.has(i)) cls.push('winner');
      const shownHand = showdown && v.lastResult.shown.find((x) => x.seat === i);
      if (shownHand) cls.push('shown');
      if (p.y < 40) cls.push('up'); // seats along the top edge show their cards below the name, toward the felt
      let tag = '';
      const win = showdown && v.lastResult.winners.find((w) => w.seat === i);
      if (shownHand) tag = ''; // the hand label above the plate says it all
      else if (win) tag = `<span class="tag win">+${fmt(win.amount)}</span>`;
      else if (s.lastAction) {
        const k = /פולד/.test(s.lastAction) ? 'fold' : /אול/.test(s.lastAction) ? 'allin' : /רייז|בט/.test(s.lastAction) ? 'raise' : '';
        tag = `<span class="tag ${k}${fresh.tags.has(i) ? ' pop' : ''}">${s.lastAction}</span>`;
      }
      const hole = s.cards.map((c, k) => cardHtml(c, (best.size && winners.has(i) ? (best.has(c) ? 'win' : 'dim') : '')
        + (fresh.hole ? ` deal-in d${(rel + k * 3) % 8}` : ''))).join('');
      html += `<div class="${cls.join(' ')}" style="left:${p.x}%;top:${p.y}%">
        <div class="hole n${s.cards.length}">${hole}</div>
        ${shownHand ? `<div class="sd-hand ${win ? 'won' : 'lost'}">${esc(shownHand.hand)}${win ? ` · +${fmt(win.amount)}` : ''}</div>` : ''}
        <div class="plate">${tag}
          <div class="pinfo">${avatarHtml(s.name, s.avatar)}
            <div class="ptext">
              <div class="pname">${esc(s.name)}</div>
              <div class="pstack">${s.allIn && s.stack === 0 ? 'אול-אין' : fmt(s.stack)}</div>
            </div>
          </div>
          ${i === v.toAct ? '<div class="timer"><i data-timer></i></div>' : ''}
        </div>
      </div>`;
      const c = betAt(p);
      if (s.bet > 0) html += `<div class="bet" style="left:${c.x}%;top:${c.y}%"><span class="chip-ico"></span>${fmt(s.bet)}</div>`;
      if (i === v.button) {
        const d = { x: 50 + (p.x - 50) * 0.72 + 4, y: 50 + (p.y - 50) * 0.7 };
        html += `<div class="dealer" style="left:${d.x}%;top:${d.y}%">D</div>`;
      }
    }
    $('seats').innerHTML = html;
    fresh = { hole: false, boardFrom: 99, tags: new Set() };
    renderActions();
    renderLog();
    renderLeaders();
  }

  $('seats').addEventListener('click', (e) => {
    const b = e.target.closest('[data-seat]');
    if (b && view) {
      const t = view;
      openModal(`באי־אין ל${t.name}`, t.minBuyIn, Math.min(t.maxBuyIn, me.chips), t.maxBuyIn,
        (amt) => conn.emit('join', { tableId: t.id, buyIn: amt, seat: Number(b.dataset.seat) }));
    }
  });

  function renderActions() {
    const v = view, bar = $('action-bar');
    const L = v.legal;
    if (!L) {
      let msg = '';
      if (v.mySeat < 0) msg = v.tournament ? 'אתה צופה בטורניר.' : 'אתה צופה בשולחן. בחר מושב פנוי או לחץ "שב לשחק".';
      else if (v.seats[v.mySeat].away) msg = 'סומנת כלא ליד השולחן, אז המערכת עושה צ\'ק או פולד בשבילך. <button class="btn btn-primary" data-back>חזרתי</button>';
      else if (v.seats[v.mySeat].stack === 0 && !(v.seats[v.mySeat].inHand && v.stage !== 'showdown')) msg = 'נגמרו הצ\'יפים בשולחן. לחץ "הוסף צ\'יפים".';
      else if (v.stage === 'waiting') msg = 'ממתינים ליד הבאה...';
      else if (v.toAct >= 0) msg = `תור של ${esc(v.seats[v.toAct].name)}`;
      bar.innerHTML = `<span class="wait-msg">${msg}</span>`;
      lastTurnKey = '';
      return;
    }
    const key = v.handNo + ':' + v.board.length + ':' + L.currentBet;
    if (key === lastTurnKey && bar.querySelector('.raise-box')) return; // keep slider position
    lastTurnKey = key;
    window.FX.play('turn');
    const potLimit = v.game.potLimit;
    const raiseWord = L.currentBet ? 'רייז ל־' : 'בט';
    const potTo = (f) => Math.round(L.currentBet + (L.pot + L.toCall) * f);
    const presets = [['½', potTo(0.5)], ['¾', potTo(0.75)], ['פוט', potTo(1)], [potLimit ? 'מקס' : 'אול-אין', L.maxRaiseTo]]
      .map(([label, to]) => [label, Math.max(L.minRaiseTo, Math.min(L.maxRaiseTo, to))]);
    bar.innerHTML = `
      <button class="btn btn-fold" data-act="fold">פולד <small>(F)</small></button>
      <button class="btn btn-call" data-act="${L.canCheck ? 'check' : 'call'}">${L.canCheck ? 'צ\'ק' : 'קול ' + fmt(L.toCall)} <small>(C)</small></button>
      ${L.canRaise ? `<div class="raise-box">
        <div class="presets">${presets.map(([l, to]) => `<button data-to="${to}">${l}</button>`).join('')}</div>
        <div class="raise-row">
          <input type="range" id="raise-range" min="${L.minRaiseTo}" max="${L.maxRaiseTo}" value="${L.minRaiseTo}" step="${v.smallBlind}">
          <input type="number" id="raise-num" min="${L.minRaiseTo}" max="${L.maxRaiseTo}" value="${L.minRaiseTo}">
        </div>
      </div>
      <button class="btn btn-raise" data-act="raise" id="raise-btn">${raiseWord} ${fmt(L.minRaiseTo)} <small>(R)</small></button>` : ''}`;
    const setRaise = (to) => {
      to = Math.max(L.minRaiseTo, Math.min(L.maxRaiseTo, Math.round(to)));
      $('raise-range').value = to; $('raise-num').value = to;
      $('raise-btn').innerHTML = `${to === L.allInTo ? 'אול-אין' : raiseWord} ${fmt(to)} <small>(R)</small>`;
    };
    if (L.canRaise) {
      $('raise-range').addEventListener('input', (e) => setRaise(Number(e.target.value)));
      $('raise-num').addEventListener('change', (e) => setRaise(Number(e.target.value)));
      bar.querySelectorAll('[data-to]').forEach((b) => b.addEventListener('click', () => setRaise(Number(b.dataset.to))));
    }
  }

  $('action-bar').addEventListener('click', (e) => {
    if (e.target.closest('[data-back]')) return conn.emit('back');
    const b = e.target.closest('[data-act]');
    if (b) act(b.dataset.act);
  });

  function act(type) {
    if (!view || !view.legal) return;
    const amount = type === 'raise' ? Number($('raise-num').value) : undefined;
    conn.emit('action', { type, amount });
    view.legal = null;
    renderActions();
  }

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || !view || !view.legal) return;
    const k = e.key.toLowerCase();
    if (k === 'f') act('fold');
    if (k === 'c') act(view.legal.canCheck ? 'check' : 'call');
    if (k === 'r' && view.legal.canRaise) act('raise');
  });

  function renderLog() {
    const el = $('panel-log');
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
    el.innerHTML = view.log.map((l) => `<div class="${l.startsWith('—') ? 'hand-sep' : ''}">${esc(l)}</div>`).join('');
    if (atBottom) el.scrollTop = el.scrollHeight;
  }

  function renderLeaders() {
    const rows = view.leaders || [];
    $('panel-lead').innerHTML = `<table class="lead">
      <thead><tr><th>#</th><th>שחקן</th><th title="ניצחונות מתוך ידיים ששוחקו (בלי פולד לפני הפלופ)">ניצחונות</th><th>%</th><th title="באיזה אחוז מהידיים השחקן נכנס ליד">משחק</th></tr></thead>
      <tbody>${rows.map((r, k) => `<tr${me && r.name === me.name ? ' class="me"' : ''}>
        <td>${k === 0 ? '🥇' : k === 1 ? '🥈' : k === 2 ? '🥉' : k + 1}</td>
        <td>${esc(r.name)}${r.best ? `<div class="muted small">${esc(r.best)}</div>` : ''}</td>
        <td>${r.won}/${r.played}</td>
        <td><b>${r.pct}%</b></td>
        <td class="muted">${r.vpip}%</td></tr>`).join('')}</tbody></table>
      <div class="muted small">נספרות רק ידיים שהשחקן שיחק אחרי הפלופ. "משחק" הוא אחוז הידיים שהשחקן לא זרק לפני הפלופ.</div>
      ${rows.length ? '' : '<div class="muted small">הטבלה מתמלאת אחרי הידיים הראשונות</div>'}
      ${`<div class="hh-table muted small">⭐ בונוס יד חזקה (מנצח בשואודאון עם הקלפים שלו):
        רביעייה x10 · סטרייט פלאש x15 · רויאל x20</div>
      <div class="hh-table muted small">🎰 ג'קפוט נוסף: ${window.PokerLobby.JACKPOTS.slice().reverse().map((j) => `${j.label} ${view.tournament ? j.buyIns + ' באי־אינים' : fmt(j.bb * view.bigBlind)}`).join(' · ')}</div>`}`;
    renderCardStats();
  }

  function renderCardStats() {
    const cs = view.cardStats;
    if (!cs) { $('panel-stats').innerHTML = '<div class="muted small">הסטטיסטיקה מתמלאת אחרי הידיים הראשונות</div>'; return; }
    const bars = (rows, label) => {
      const max = Math.max(1, ...rows.map((r) => r[1]));
      return rows.map(([k, n]) => `<div class="sbar"><span class="sk">${label(k)}</span><i style="--w:${(n / max) * 100}%"></i><b>${n}</b></div>`).join('');
    };
    const rankLabel = (r) => (r === 'T' ? '10' : r);
    const cardLabel = (c) => `<span class="mini ${c[1]}">${rankLabel(c[0])}${SUIT[c[1]]}</span>`;
    $('panel-stats').innerHTML = `<div class="muted small">${fmt(cs.hands)} ידיים בשולחן הזה</div>
      <h4>הקלפים שיצאו הכי הרבה</h4>${bars(cs.ranks.slice(0, 6), rankLabel)}
      <h4>הקלפים המדויקים הכי נפוצים</h4>${bars(cs.cards, cardLabel)}
      <h4>הידיים שהגיעו הכי הרבה לשואודאון</h4>${cs.made.length ? bars(cs.made, (h) => esc(h)) : '<div class="muted small">עוד לא היה שואודאון</div>'}`;
  }

  function renderChat() {
    const el = $('chat-msgs');
    el.innerHTML = chatLines.map((m) => `<div><b>${esc(m.name)}:</b> ${esc(m.text)}</div>`).join('');
    el.scrollTop = el.scrollHeight;
  }
  $('chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('chat-input').value.trim();
    if (text) conn.emit('chat', { text });
    $('chat-input').value = '';
  });
  document.querySelector('.side-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-p]');
    if (!b) return;
    document.querySelectorAll('.side-tabs .tab').forEach((x) => x.classList.toggle('active', x === b));
    $('panel-lead').classList.toggle('hidden', b.dataset.p !== 'lead');
    $('panel-stats').classList.toggle('hidden', b.dataset.p !== 'stats');
    $('panel-log').classList.toggle('hidden', b.dataset.p !== 'log');
    $('panel-chat').classList.toggle('hidden', b.dataset.p !== 'chat');
  });

  // ---------- misc ----------
  function tick() {
    const bar = document.querySelector('[data-timer]');
    if (bar && view) {
      const left = Math.max(0, localDeadline - Date.now());
      const frac = left / view.turnMs;
      bar.style.width = (frac * 100).toFixed(1) + '%';
      bar.style.background = frac < 0.25 ? 'var(--red)' : 'var(--gold)';
      // Clock ticks during your last five seconds.
      const sec = Math.ceil(left / 1000);
      if (view.legal && sec <= 5 && sec > 0 && sec !== lastTickSec) window.FX.play('tick');
      lastTickSec = sec;
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  let lastTickSec = 0;
  let tourHudUntil = 0;
  setInterval(() => {
    const el = document.querySelector('[data-level-clock]');
    if (!el) return;
    const left = Math.max(0, Math.round((tourHudUntil - Date.now()) / 1000));
    el.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  }, 500);

  // ---------- admin ----------
  let adminData = { users: [], pending: 0 };
  conn.on('admin', (d) => {
    adminData = d;
    $('admin-badge').textContent = d.pending;
    $('admin-badge').classList.toggle('hidden', !d.pending);
    renderAdmin();
  });
  conn.on('admin:request', (r) => { window.FX.play('turn'); toast(`${r.name} (${r.phone}) מבקש להיכנס`); });
  conn.on('admin:chips', (r) => { window.FX.play('turn'); toast(`${r.name} מבקש צ'יפים (יש לו ${fmt(r.chips)})`); });
  $('admin-btn').addEventListener('click', () => { renderAdmin(); $('admin').classList.remove('hidden'); });
  $('admin-close').addEventListener('click', () => $('admin').classList.add('hidden'));
  function renderAdmin() {
    const label = { approved: 'מאושר', pending: 'ממתין', blocked: 'חסום' };
    $('admin-list').innerHTML = adminData.users.map((u) => `<div class="arow ${u.waiting ? 'waiting' : ''}">
      <div class="ainfo"><b>${esc(u.name)}</b>${u.isAdmin ? ' <span class="pill">מנהל</span>' : ''}
        <div class="muted small" dir="ltr">${esc(u.phone)}</div>
        <div class="small"><span class="pill ${u.status}">${label[u.status]}</span>${u.newDevice ? ' <span class="pill pending">מכשיר חדש</span>' : ''}${u.wantsChips ? ' <span class="pill pending">מבקש צ\'יפים</span>' : ''} · ${fmt(u.chips)} צ'יפים</div>
      </div>
      <div class="aact">
        ${u.waiting ? `<button class="btn btn-primary" data-aop="approve" data-uid="${u.uid}">אשר</button>` : ''}
        ${!u.isAdmin && u.status !== 'blocked' ? `<button class="btn btn-ghost" data-aop="block" data-uid="${u.uid}">חסום</button>` : ''}
        ${u.status === 'blocked' ? `<button class="btn btn-ghost" data-aop="unblock" data-uid="${u.uid}">בטל חסימה</button>` : ''}
        ${u.status === 'approved' ? `<span class="chip-give"><input type="number" step="1000" value="10000" data-amt="${u.uid}" aria-label="כמות צ'יפים"><button class="btn btn-ghost" data-aop="chips" data-uid="${u.uid}">הוסף</button></span>` : ''}
      </div>
    </div>`).join('') || '<div class="muted">אין עדיין חברים רשומים</div>';
  }
  $('admin-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-aop]');
    if (!b) return;
    const amt = document.querySelector(`[data-amt="${b.dataset.uid}"]`);
    conn.emit('admin', { op: b.dataset.aop, uid: b.dataset.uid, amount: amt ? Number(amt.value) : 0 });
  });

  let toastTimer;
  function toast(msg) {
    $('toast').textContent = msg;
    $('toast').classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 3000);
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  window.addEventListener('resize', () => view && me && me.tableId && renderTable());
  if (load('rf_name') && params.has('auto')) $('login-form').requestSubmit();
})();
