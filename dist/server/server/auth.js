import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
const N = 16384, KEYLEN = 32;
export function hashPassword(pw) {
    const salt = randomBytes(16);
    const h = scryptSync(pw, salt, KEYLEN, { N, r: 8, p: 1 });
    return `scrypt$${N}$${salt.toString('base64')}$${h.toString('base64')}`;
}
export function verifyPassword(pw, stored) {
    const [alg, n, s, h] = stored.split('$');
    if (alg !== 'scrypt')
        return false;
    const want = Buffer.from(h, 'base64');
    const got = scryptSync(pw, Buffer.from(s, 'base64'), want.length, { N: Number(n), r: 8, p: 1 });
    return timingSafeEqual(want, got);
}
const sha = (t) => createHash('sha256').update(t).digest('hex');
const TTL = 7 * 24 * 3600 * 1000;
export function createSession(db, accountId) {
    const token = randomBytes(32).toString('base64url');
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    db.prepare('INSERT INTO sessions (token_hash, account_id, expires_at) VALUES (?,?,?)').run(sha(token), accountId, Date.now() + TTL);
    return token;
}
export function accountFromToken(db, token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100)
        return null;
    const row = db.prepare('SELECT account_id, expires_at FROM sessions WHERE token_hash = ?').get(sha(token));
    if (!row || row.expires_at < Date.now())
        return null;
    return row.account_id;
}
export function deleteSession(db, token) { db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token)); }
/** 簡單的固定視窗速率限制 */
export class RateLimiter {
    max;
    windowMs;
    hits = new Map();
    constructor(max, windowMs) {
        this.max = max;
        this.windowMs = windowMs;
    }
    /** 回傳 true 表示允許 */
    take(key) {
        const now = Date.now();
        let h = this.hits.get(key);
        if (!h || h.reset < now) {
            h = { n: 0, reset: now + this.windowMs };
            this.hits.set(key, h);
        }
        if (this.hits.size > 10000)
            for (const [k, v] of this.hits)
                if (v.reset < now)
                    this.hits.delete(k);
        return ++h.n <= this.max;
    }
    retryAfterSec(key) { const h = this.hits.get(key); return h ? Math.ceil((h.reset - Date.now()) / 1000) : 0; }
    reset(key) { this.hits.delete(key); }
}
