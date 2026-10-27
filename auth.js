// Members: sign-up with a phone number, approval by the admin, one token per approved device.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class Auth {
  // opts: file, adminPhone, adminPin
  constructor(opts) {
    this.file = opts.file;
    this.adminPhone = opts.adminPhone ? Auth.normPhone(opts.adminPhone) : null;
    this.adminPin = opts.adminPin || null;
    try { this.users = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.users = {}; }
    this.saveTimer = null;
  }

  // Digits only, Israeli +972 numbers written with a leading 0.
  static normPhone(raw) {
    let d = String(raw || '').replace(/\D/g, '');
    if (d.startsWith('972')) d = '0' + d.slice(3);
    return d.length >= 9 && d.length <= 15 ? d : null;
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.users, null, 1));
    }, 500);
  }

  byPhone(phone) { return Object.values(this.users).find((u) => u.phone === phone); }

  hasAdmin() { return Object.values(this.users).some((u) => u.isAdmin); }

  // Returns { status: 'approved' | 'pending' | 'blocked', user, token } or { error }.
  login({ name, phone, token, pin }) {
    phone = Auth.normPhone(phone);
    if (!phone) return { error: 'צריך מספר טלפון תקין' };
    name = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 16);
    if (!name) return { error: 'צריך כינוי' };
    let u = this.byPhone(phone);
    if (!u) {
      const becomesAdmin = this.adminPhone ? phone === this.adminPhone : !this.hasAdmin();
      u = {
        uid: crypto.randomBytes(6).toString('hex'), name, phone, isAdmin: becomesAdmin,
        status: becomesAdmin ? 'approved' : 'pending', tokens: [], pendingTokens: [], createdAt: Date.now(),
      };
      this.users[u.uid] = u;
    }
    if (u.status === 'blocked') return { status: 'blocked', user: u };
    if (token && u.tokens.includes(token)) {
      if (u.name !== name) u.name = name;
      this.save();
      return { status: 'approved', user: u, token };
    }
    // A new device.
    const fresh = crypto.randomBytes(16).toString('hex');
    const adminByPin = u.isAdmin && this.adminPin && pin === this.adminPin;
    if ((u.isAdmin && u.tokens.length === 0) || adminByPin) {
      u.tokens.push(fresh);
      u.status = 'approved';
      this.save();
      return { status: 'approved', user: u, token: fresh };
    }
    u.name = name;
    u.pendingTokens = [...u.pendingTokens.slice(-2), fresh];
    if (u.status !== 'approved') u.status = 'pending';
    u.requestedAt = Date.now();
    this.save();
    return { status: 'pending', user: u, token: fresh, newDevice: u.tokens.length > 0 };
  }

  approve(uid) {
    const u = this.users[uid];
    if (!u) return null;
    u.tokens = [...u.tokens, ...u.pendingTokens].slice(-5);
    u.pendingTokens = [];
    u.status = 'approved';
    this.save();
    return u;
  }

  setAvatar(uid, dataUrl) {
    const u = this.users[uid];
    if (!u) return null;
    u.avatar = dataUrl || null;
    u.avatarAt = Date.now();
    this.save();
    return u;
  }

  block(uid) {
    const u = this.users[uid];
    if (!u || u.isAdmin) return null;
    u.status = 'blocked';
    u.tokens = [];
    u.pendingTokens = [];
    this.save();
    return u;
  }

  unblock(uid) {
    const u = this.users[uid];
    if (!u) return null;
    u.status = 'pending';
    this.save();
    return u;
  }

  remove(uid) {
    const u = this.users[uid];
    if (!u || u.isAdmin) return null;
    delete this.users[uid];
    this.save();
    return u;
  }

  list() {
    return Object.values(this.users)
      .map((u) => ({
        uid: u.uid, name: u.name, phone: u.phone, status: u.status, isAdmin: !!u.isAdmin,
        waiting: u.pendingTokens.length > 0, newDevice: u.pendingTokens.length > 0 && u.tokens.length > 0,
        requestedAt: u.requestedAt || u.createdAt, wantsChips: !!u.chipReqAt,
      }))
      .sort((a, b) => (b.waiting - a.waiting) || (b.requestedAt - a.requestedAt));
  }

  pendingCount() { return Object.values(this.users).filter((u) => u.pendingTokens.length > 0 && u.status !== 'blocked').length; }
}

module.exports = { Auth };
