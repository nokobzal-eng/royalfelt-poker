// Table effects: synthesized sounds, flying chips, hand banners, confetti and the Mystery Bounty reveal.
(function (global) {
  'use strict';

  // ---------- sound ----------
  let ctx = null;
  let muted = false;
  try { muted = global.localStorage.getItem('rf_mute') === '1'; } catch (e) { /* storage unavailable */ }

  function audio() {
    if (muted) return null;
    if (!ctx) {
      const C = global.AudioContext || global.webkitAudioContext;
      if (!C) return null;
      ctx = new C();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tone(freq, dur, type, vol, when, slideTo) {
    const a = audio();
    if (!a) return;
    const t = a.currentTime + (when || 0);
    const o = a.createOscillator(), g = a.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol || 0.06, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(a.destination);
    o.start(t); o.stop(t + dur + 0.02);
  }

  function noise(dur, vol, freq, when) {
    const a = audio();
    if (!a) return;
    const t = a.currentTime + (when || 0);
    const buf = a.createBuffer(1, Math.ceil(a.sampleRate * dur), a.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const src = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
    src.buffer = buf; f.type = 'bandpass'; f.frequency.value = freq || 2000; g.gain.value = vol || 0.1;
    src.connect(f); f.connect(g); g.connect(a.destination);
    src.start(t);
  }

  const SOUNDS = {
    deal: (w) => noise(0.07, 0.35, 3500, w),
    chip: (w) => { tone(2600, 0.05, 'triangle', 0.05, w); tone(3400, 0.05, 'triangle', 0.04, (w || 0) + 0.04); tone(2900, 0.05, 'triangle', 0.035, (w || 0) + 0.08); },
    check: () => { noise(0.05, 0.6, 350); noise(0.05, 0.5, 350, 0.11); },
    fold: () => noise(0.22, 0.2, 1200),
    turn: () => { tone(660, 0.12, 'sine', 0.08); tone(990, 0.18, 'sine', 0.08, 0.11); },
    tick: () => tone(1500, 0.03, 'square', 0.025),
    allin: () => { tone(98, 0.6, 'sawtooth', 0.05); tone(147, 0.6, 'sawtooth', 0.04, 0.05); tone(196, 0.7, 'sawtooth', 0.04, 0.1); },
    win: () => [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.28, 'triangle', 0.07, i * 0.09)),
    big: () => [523, 659, 784, 1046, 1318, 1568, 2093].forEach((f, i) => tone(f, 0.35, 'triangle', 0.08, i * 0.08)),
    spin: (w) => tone(900 + Math.random() * 600, 0.04, 'square', 0.03, w),
    reveal: () => { tone(220, 0.5, 'sawtooth', 0.04, 0, 880); [784, 988, 1175, 1568].forEach((f, i) => tone(f, 0.4, 'triangle', 0.08, 0.45 + i * 0.1)); },
  };

  function play(name, when) { try { if (SOUNDS[name]) SOUNDS[name](when); } catch (e) { /* audio blocked */ } }
  function setMuted(m) {
    muted = m;
    try { global.localStorage.setItem('rf_mute', m ? '1' : '0'); } catch (e) { /* ignore */ }
  }

  const reduced = () => global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- chips ----------
  // Positions are percentages of the container.
  function flyChips(container, from, to, count, delay) {
    const n = Math.min(count || 4, 8);
    for (let k = 0; k < n; k++) {
      const el = document.createElement('div');
      el.className = 'fly-chip';
      el.style.left = from.x + '%';
      el.style.top = from.y + '%';
      container.appendChild(el);
      const dx = (to.x - from.x) / 100 * container.clientWidth;
      const dy = (to.y - from.y) / 100 * container.clientHeight;
      setTimeout(() => {
        el.style.transform = `translate(calc(-50% + ${dx + (Math.random() * 14 - 7)}px), calc(-50% + ${dy + (Math.random() * 10 - 5)}px))`;
        el.style.opacity = '0.2';
      }, (delay || 0) + k * 45 + 20);
      setTimeout(() => el.remove(), (delay || 0) + k * 45 + 700);
    }
  }

  // ---------- banner ----------
  function banner(container, title, sub, kind) {
    const el = document.createElement('div');
    el.className = 'fx-banner ' + (kind || '');
    el.innerHTML = `<div class="fx-title"></div><div class="fx-sub"></div>`;
    el.firstChild.textContent = title;
    el.lastChild.textContent = sub || '';
    container.appendChild(el);
    setTimeout(() => el.classList.add('out'), 2200);
    setTimeout(() => el.remove(), 2700);
  }

  // ---------- confetti ----------
  function confetti(container, power, palette) {
    const cnv = document.createElement('canvas');
    cnv.className = 'fx-confetti';
    container.appendChild(cnv);
    const W = cnv.width = container.clientWidth * (global.devicePixelRatio || 1);
    const H = cnv.height = container.clientHeight * (global.devicePixelRatio || 1);
    const g = cnv.getContext('2d');
    const colors = palette || ['#e0283c', '#f2c14e', '#22c55e', '#3b82f6', '#ffffff', '#ff7ab6'];
    const n = Math.round((reduced() ? 40 : 160) * (power || 1));
    const parts = [];
    for (let i = 0; i < n; i++) {
      const fromLeft = i % 2 === 0;
      parts.push({
        x: fromLeft ? W * 0.1 : W * 0.9, y: H * 0.75,
        vx: (fromLeft ? 1 : -1) * (W * (0.004 + Math.random() * 0.012)), vy: -H * (0.012 + Math.random() * 0.018),
        r: (4 + Math.random() * 6) * (global.devicePixelRatio || 1), rot: Math.random() * 6, vr: Math.random() * 0.3 - 0.15,
        c: colors[i % colors.length], shape: Math.random() < 0.3 ? 'c' : 'r',
      });
    }
    const start = performance.now();
    function frame(now) {
      const t = now - start;
      g.clearRect(0, 0, W, H);
      for (const p of parts) {
        p.vy += H * 0.00045; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
        g.save(); g.translate(p.x, p.y); g.rotate(p.rot); g.fillStyle = p.c;
        g.globalAlpha = Math.max(0, 1 - t / 3200);
        if (p.shape === 'c') { g.beginPath(); g.arc(0, 0, p.r / 2, 0, 7); g.fill(); }
        else g.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2);
        g.restore();
      }
      if (t < 3200) requestAnimationFrame(frame);
      else cnv.remove();
    }
    requestAnimationFrame(frame);
  }

  // ---------- Mystery Bounty reveal ----------
  function bountyReveal(container, b, fmt) {
    const el = document.createElement('div');
    el.className = 'bounty-reveal' + (b.jackpot ? ' jackpot' : '');
    el.innerHTML = `<div class="br-card">
      <div class="br-label">MYSTERY BOUNTY</div>
      <div class="br-box">🎁</div>
      <div class="br-amount">?</div>
      <div class="br-who"></div>
    </div>`;
    el.querySelector('.br-who').textContent = `${b.to} לקח את הבאונטי של ${b.from}`;
    container.appendChild(el);
    const amt = el.querySelector('.br-amount');
    const steps = 18;
    let k = 0;
    const spin = () => {
      if (k < steps) {
        amt.textContent = fmt(b.tiers[k % b.tiers.length]);
        play('spin');
        k++;
        setTimeout(spin, 60 + k * k * 1.2);
      } else {
        amt.textContent = fmt(b.amount);
        el.classList.add('opened');
        el.querySelector('.br-label').textContent = b.tier.toUpperCase ? `באונטי ${b.tier}` : 'MYSTERY BOUNTY';
        play(b.jackpot ? 'big' : 'reveal');
        confetti(container, b.jackpot ? 2.2 : 1, b.jackpot ? ['#f2c14e', '#ffe08a', '#fff4c2', '#e0283c'] : null);
        setTimeout(() => el.classList.add('out'), b.jackpot ? 3800 : 2600);
        setTimeout(() => el.remove(), b.jackpot ? 4300 : 3100);
      }
    };
    setTimeout(spin, 700);
  }

  global.FX = { play, setMuted, isMuted: () => muted, flyChips, banner, confetti, bountyReveal };
})(typeof window !== 'undefined' ? window : globalThis);
