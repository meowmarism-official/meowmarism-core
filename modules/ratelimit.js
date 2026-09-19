// Login throttling: progressive lockout per IP+username and a coarser cap per IP.
const WINDOW_MS = 10 * 60 * 1000;
const IP_MAX_FAILS = 20;
const IP_LOCK_MS = 15 * 60 * 1000;
const USER_FREE_TRIES = 3;
const USER_BASE_LOCK_MS = 5000;
const USER_MAX_LOCK_MS = 15 * 60 * 1000;

function createLoginLimiter(now = () => Date.now()) {
  const byUser = new Map(); // "ip|user" -> { fails, lockedUntil, last }
  const byIp = new Map(); // ip -> { fails, windowStart, lockedUntil }

  function sweep() {
    const t = now();
    for (const [k, v] of byUser) if (t - v.last > USER_MAX_LOCK_MS * 2) byUser.delete(k);
    for (const [k, v] of byIp) if (t - v.windowStart > WINDOW_MS && t > v.lockedUntil) byIp.delete(k);
  }
  const timer = setInterval(sweep, 60000);
  if (timer.unref) timer.unref();

  const key = (ip, user) => `${ip}|${String(user).toLowerCase()}`;

  function check(ip, user) {
    const t = now();
    const u = byUser.get(key(ip, user));
    const i = byIp.get(ip);
    const until = Math.max(u ? u.lockedUntil : 0, i ? i.lockedUntil : 0);
    return until > t ? { allowed: false, retryAfterSec: Math.ceil((until - t) / 1000) } : { allowed: true };
  }

  function fail(ip, user) {
    const t = now();
    const k = key(ip, user);
    const u = byUser.get(k) || { fails: 0, lockedUntil: 0, last: t };
    u.fails += 1;
    u.last = t;
    if (u.fails > USER_FREE_TRIES) u.lockedUntil = t + Math.min(USER_MAX_LOCK_MS, USER_BASE_LOCK_MS * 2 ** (u.fails - USER_FREE_TRIES - 1));
    byUser.set(k, u);
    let i = byIp.get(ip);
    if (!i || t - i.windowStart > WINDOW_MS) i = { fails: 0, windowStart: t, lockedUntil: i ? i.lockedUntil : 0 };
    i.fails += 1;
    if (i.fails >= IP_MAX_FAILS) i.lockedUntil = t + IP_LOCK_MS;
    byIp.set(ip, i);
  }

  function success(ip, user) {
    byUser.delete(key(ip, user));
  }

  return { check, fail, success };
}

module.exports = { createLoginLimiter };
