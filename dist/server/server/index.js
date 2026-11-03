// HTTP（REST + 靜態檔）與 WebSocket，單一埠
import http from 'node:http';
import { readFileSync, existsSync, statSync, createReadStream } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import { WebSocketServer } from 'ws';
import { loadContent, ROOT } from './content.js';
import { openDb, maxItemId, saveItems } from './db.js';
import { hashPassword, verifyPassword, createSession, accountFromToken, deleteSession, RateLimiter } from './auth.js';
import { World, DEFAULT_SETTINGS } from './world.js';
import { Systems } from './systems.js';
import { Features } from './features.js';
import { isGear, newUid, setUidBase } from '../shared/rules.js';
import { CHAT_CHANNELS } from '../shared/protocol.js';
import { C2S_TYPES } from '../shared/protocol.js';
import { SLOTS } from '../shared/types.js';
const PORT = Number(process.env.PORT ?? 3000);
const VERSION = process.env.APP_VERSION ?? JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const CLIENT_DIR = join(ROOT, 'dist/client');
const content = loadContent();
const db = openDb(process.env.DB_FILE ?? join(ROOT, 'data/game.db'));
setUidBase(maxItemId(db));
const world = new World(content, db);
const sys = new Systems(world);
const GM_NAMES = new Set((process.env.GM_NAMES ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
const feat = new Features(world, sys, GM_NAMES);
sys.extraOpts = (p, npc) => feat.dialogOpts(p, npc);
sys.guildChat = (p, text) => { if (!p.guild) {
    world.log(p, '你尚未加入誓盟', 'warn');
    return;
} feat.guildSay(p.guild.id, text, `[${p.guild.tag}]${p.name}`); };
const loginLimiter = new RateLimiter(10, 5 * 60_000); // 每 IP 每 5 分鐘 10 次登入嘗試
const userLimiter = new RateLimiter(5, 5 * 60_000); // 每帳號每 5 分鐘 5 次失敗
const registerLimiter = new RateLimiter(10, 60 * 60_000);
const MAX_BODY = 8 * 1024;
// ---------- 工具 ----------
class HttpError extends Error {
    status;
    extra;
    constructor(status, msg, extra = {}) {
        super(msg);
        this.status = status;
        this.extra = extra;
    }
}
function json(res, status, body, headers = {}) {
    const s = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
    res.end(s);
}
function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (c) => { size += c.length; if (size > MAX_BODY) {
            reject(new HttpError(413, '請求過大'));
            req.destroy();
        }
        else
            chunks.push(c); });
        req.on('end', () => {
            if (!chunks.length)
                return resolve({});
            try {
                const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                if (typeof v !== 'object' || !v || Array.isArray(v))
                    throw 0;
                resolve(v);
            }
            catch {
                reject(new HttpError(400, 'JSON 格式錯誤'));
            }
        });
        req.on('error', reject);
    });
}
// 反向代理後方取得真實 IP：TRUST_PROXY=cloudflare 讀 CF-Connecting-IP；TRUST_PROXY=1 讀 X-Forwarded-For 第一個；未設定則用連線位址
const TRUST_PROXY = process.env.TRUST_PROXY ?? '';
const ip = (req) => {
    const h = (k) => { const v = req.headers[k]; return (Array.isArray(v) ? v[0] : v ?? '').trim(); };
    if (TRUST_PROXY === 'cloudflare' && h('cf-connecting-ip'))
        return h('cf-connecting-ip').slice(0, 64);
    if (TRUST_PROXY && TRUST_PROXY !== 'cloudflare' && h('x-forwarded-for'))
        return h('x-forwarded-for').split(',')[0].trim().slice(0, 64);
    return req.socket.remoteAddress ?? '?';
};
function auth(req) {
    const h = req.headers.authorization ?? '';
    const id = accountFromToken(db, h.startsWith('Bearer ') ? h.slice(7) : '');
    if (!id)
        throw new HttpError(401, '請先登入');
    return id;
}
const USER_RE = /^[A-Za-z0-9_]{3,16}$/;
const NAME_RE = /^[\p{Script=Han}A-Za-z0-9_]{2,12}$/u;
function validCreds(b) {
    const { username, password } = b;
    if (typeof username !== 'string' || !USER_RE.test(username))
        throw new HttpError(400, '帳號需為 3–16 個英數字或底線');
    if (typeof password !== 'string' || password.length < 6 || password.length > 64)
        throw new HttpError(400, '密碼需為 6–64 個字元');
    return { username, password };
}
function publicChar(r) {
    const eq = db.prepare("SELECT slot, key FROM items WHERE char_id = ? AND loc = 'eq'").all(r.id);
    const tier = (s, d) => { const e = eq.find(x => x.slot === s); return e ? Math.min(2, content.items[e.key]?.tier ?? 0) : d; };
    return { id: r.id, slot: r.slot, name: r.name, job: r.job, level: r.level, map: r.map, mapName: content.maps[r.map]?.name ?? r.map, autoHunt: !!r.auto_hunt, body: tier('armor', 0), wpn: tier('weapon', -1) };
}
// ---------- 路由 ----------
async function api(req, res, path) {
    const m = req.method;
    if (path === '/api/health' && m === 'GET')
        return json(res, 200, { ok: true, version: VERSION, online: world.onlineCount() });
    if (path === '/api/content' && m === 'GET') {
        const { classes, skills, items, monsters, npcs, shops, quests, achievements, teleports, startMap } = content;
        const maps = Object.fromEntries(Object.values(content.maps).map(m => [m.id, { name: m.name, level: m.level, safe: !!m.safe, theme: m.theme }]));
        return json(res, 200, { version: VERSION, classes, skills, items, monsters, npcs, shops, quests, achievements, teleports, startMap, maps }, { 'cache-control': 'public, max-age=60' });
    }
    if (path.startsWith('/api/map/') && m === 'GET') {
        const def = content.maps[path.slice(9)];
        return def ? json(res, 200, def, { 'cache-control': 'public, max-age=300' }) : json(res, 404, { error: '找不到地圖' });
    }
    if (path === '/api/register' && m === 'POST') {
        if (!registerLimiter.take(ip(req)))
            throw new HttpError(429, '註冊太頻繁，請稍後再試');
        const { username, password } = validCreds(await readBody(req));
        if (db.prepare('SELECT 1 FROM accounts WHERE username = ?').get(username))
            throw new HttpError(409, '帳號已被使用');
        const r = db.prepare('INSERT INTO accounts (username, pass_hash, created_at) VALUES (?,?,?)').run(username, hashPassword(password), Date.now());
        return json(res, 201, { token: createSession(db, Number(r.lastInsertRowid)), username });
    }
    if (path === '/api/login' && m === 'POST') {
        const b = await readBody(req);
        if (!loginLimiter.take(ip(req)))
            throw new HttpError(429, '嘗試次數過多，請稍後再試', { 'retry-after': String(loginLimiter.retryAfterSec(ip(req))) });
        const { username, password } = validCreds(b);
        const key = username.toLowerCase();
        const row = db.prepare('SELECT id, pass_hash FROM accounts WHERE username = ?').get(username);
        if (!row || !verifyPassword(password, row.pass_hash)) {
            if (!userLimiter.take(key))
                throw new HttpError(429, '此帳號登入失敗次數過多，請稍後再試');
            throw new HttpError(401, '帳號或密碼錯誤');
        }
        userLimiter.reset(key);
        return json(res, 200, { token: createSession(db, row.id), username });
    }
    if (path === '/api/logout' && m === 'POST') {
        const h = req.headers.authorization ?? '';
        if (h.startsWith('Bearer '))
            deleteSession(db, h.slice(7));
        return json(res, 200, { ok: true });
    }
    if (path === '/api/characters') {
        const acc = auth(req);
        if (m === 'GET') {
            const rows = db.prepare('SELECT * FROM characters WHERE account_id = ? ORDER BY slot').all(acc);
            return json(res, 200, { slots: 3, characters: rows.map(publicChar) });
        }
        if (m === 'POST') {
            const b = await readBody(req);
            const slot = Number(b.slot), name = b.name, job = b.job;
            if (!Number.isInteger(slot) || slot < 0 || slot > 2)
                throw new HttpError(400, '角色欄位錯誤');
            if (typeof name !== 'string' || !NAME_RE.test(name))
                throw new HttpError(400, '名稱需為 2–12 個中英數字');
            if (typeof job !== 'string' || !content.classes[job])
                throw new HttpError(400, '職業錯誤');
            if (db.prepare('SELECT 1 FROM characters WHERE account_id = ? AND slot = ?').get(acc, slot))
                throw new HttpError(409, '此欄位已有角色');
            if (db.prepare('SELECT 1 FROM characters WHERE name = ?').get(name))
                throw new HttpError(409, '名稱已被使用');
            const cls = content.classes[job], start = content.maps[content.startMap];
            const inv = cls.startItems.map(key => ({ uid: newUid(), key, qty: 1 }));
            const eq = {};
            for (const it of [...inv]) {
                const d = content.items[it.key];
                if (isGear(d) && !eq[d.type]) {
                    eq[d.type] = it;
                    inv.splice(inv.indexOf(it), 1);
                }
            }
            inv.push({ uid: newUid(), key: 'p_hp', qty: 10 }, { uid: newUid(), key: 'p_mp', qty: 5 });
            const skills = { [cls.skills[0]]: 1 };
            const r = db.transaction(() => {
                const r = db.prepare(`INSERT INTO characters (account_id, slot, name, job, hp, mp, map, x, y, skills, quests, settings, daily, achievements, stats, migrated, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`)
                    .run(acc, slot, name, job, 9999, 9999, start.id, start.spawn.x + 0.5, start.spawn.y + 0.5, JSON.stringify(skills), JSON.stringify({ active: {}, done: [] }), JSON.stringify(DEFAULT_SETTINGS), JSON.stringify({ last: null, streak: 0 }), JSON.stringify({ done: [] }), '{}', Date.now());
                saveItems(db, Number(r.lastInsertRowid), inv, eq);
                return r;
            })();
            const row = db.prepare('SELECT * FROM characters WHERE id = ?').get(r.lastInsertRowid);
            return json(res, 201, { character: publicChar(row) });
        }
        if (m === 'DELETE') {
            const b = await readBody(req);
            const id = Number(b.id);
            const row = db.prepare('SELECT * FROM characters WHERE id = ? AND account_id = ?').get(id, acc);
            if (!row)
                throw new HttpError(404, '角色不存在');
            if (b.confirmName !== row.name)
                throw new HttpError(400, '請輸入角色名稱確認刪除');
            world.kickChar(row.id);
            db.prepare('DELETE FROM characters WHERE id = ?').run(row.id);
            return json(res, 200, { ok: true });
        }
    }
    if (path === '/api/leaderboard' && m === 'GET') {
        world.saveDirty();
        const rows = db.prepare('SELECT name, level FROM characters ORDER BY level DESC, exp DESC, id ASC LIMIT 50').all();
        return json(res, 200, { rows: rows.map((r, i) => ({ rank: i + 1, name: r.name, level: r.level })) }, { 'cache-control': 'public, max-age=10' });
    }
    throw new HttpError(404, '找不到 API');
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg' };
let indexTpl = null;
function serveFile(res, file, cache) {
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': cache, 'x-content-type-options': 'nosniff', 'content-length': statSync(file).size });
    createReadStream(file).pipe(res);
}
function serveStatic(req, res, path) {
    if (req.method !== 'GET' && req.method !== 'HEAD')
        return json(res, 405, { error: 'method not allowed' });
    if (path.startsWith('/content/maps/')) {
        const f = normalize(join(ROOT, path));
        const base = join(ROOT, 'content/maps');
        if (f.startsWith(base) && f.endsWith('.json') && existsSync(f))
            return serveFile(res, f, 'public, max-age=60');
        return json(res, 404, { error: 'not found' });
    }
    const f = normalize(join(CLIENT_DIR, decodeURIComponent(path)));
    if (f.startsWith(CLIENT_DIR) && path !== '/' && existsSync(f) && statSync(f).isFile() && !f.endsWith('index.html')) {
        const immutable = /\.[0-9a-f]{8}\.(png|json|webp|woff2|ttf)$/.test(f) || path.startsWith('/assets/') && !path.endsWith('manifest.json');
        return serveFile(res, f, immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
    }
    // SPA 入口：伺服器把 package.json 版本注入 meta
    if (!indexTpl || process.env.NODE_ENV === 'development')
        indexTpl = readFileSync(join(CLIENT_DIR, 'index.html'), 'utf8');
    res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY' });
    res.end(indexTpl.replaceAll('__APP_VERSION__', VERSION));
}
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    try {
        if (url.pathname.startsWith('/api/'))
            await api(req, res, url.pathname);
        else
            serveStatic(req, res, url.pathname);
    }
    catch (e) {
        if (e instanceof HttpError)
            json(res, e.status, { error: e.message }, e.extra);
        else {
            console.error(e);
            json(res, 500, { error: '伺服器錯誤' });
        }
    }
});
// ---------- WebSocket ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: 2048 });
server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '/', 'http://x').pathname !== '/ws')
        return socket.destroy();
    wss.handleUpgrade(req, socket, head, ws => onSocket(ws));
});
const num = (v) => typeof v === 'number' && Number.isFinite(v);
function onSocket(ws) {
    let charId = null;
    let tokens = 20, last = Date.now(), dropped = 0;
    const conn = {
        send: (m) => { if (ws.readyState === ws.OPEN && ws.bufferedAmount < 1_000_000)
            ws.send(JSON.stringify(m)); },
        close: (code, reason) => { try {
            ws.close(code, reason);
        }
        catch { /* noop */ } },
    };
    const authTimer = setTimeout(() => conn.close(4003, 'auth-timeout'), 5000);
    ws.on('message', (raw, isBinary) => {
        const now = Date.now();
        tokens = Math.min(20, tokens + ((now - last) / 1000) * 15);
        last = now;
        if (tokens < 1) {
            if (++dropped > 60)
                conn.close(4400, 'rate-limit');
            return;
        }
        tokens--;
        if (isBinary)
            return conn.close(4400, 'binary-not-supported');
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        }
        catch {
            return conn.close(4400, 'bad-json');
        }
        if (!msg || typeof msg.type !== 'string' || !C2S_TYPES.includes(msg.type))
            return;
        if (charId === null) {
            if (msg.type !== 'auth')
                return conn.close(4003, 'auth-required');
            clearTimeout(authTimer);
            if (msg.clientVersion !== VERSION) {
                conn.send({ t: 'requiredUpdate', version: VERSION });
                return conn.close(4009, 'required-update');
            }
            const acc = accountFromToken(db, msg.token);
            const row = acc && num(msg.characterId) ? db.prepare('SELECT * FROM characters WHERE id = ? AND account_id = ?').get(msg.characterId, acc) : undefined;
            if (!row)
                return conn.close(4003, 'auth-failed');
            charId = row.id;
            world.join(row, conn);
            return;
        }
        const p = world.players.get(charId);
        if (!p || p.conn !== conn)
            return;
        const str = (v, max = 40) => typeof v === 'string' && v.length > 0 && v.length <= max;
        const int = (v) => num(v) && Number.isInteger(v);
        switch (msg.type) {
            case 'move':
                if (num(msg.x) && num(msg.y))
                    world.cmdMove(p, msg.x, msg.y);
                break;
            case 'attack':
                if (str(msg.targetId, 20))
                    world.cmdAttack(p, msg.targetId);
                break;
            case 'useSkill':
                if (str(msg.skillId))
                    world.cmdSkill(p, msg.skillId, str(msg.targetId, 20) ? msg.targetId : undefined);
                break;
            case 'usePotion':
                world.cmdUsePotion(p, msg.kind === 'mp' ? 'mp' : 'hp');
                break;
            case 'useItem':
                if (int(msg.uid))
                    world.cmdUseItem(p, msg.uid);
                break;
            case 'equip':
                if (int(msg.uid))
                    world.cmdEquip(p, msg.uid);
                break;
            case 'unequip':
                if (SLOTS.includes(msg.slot))
                    world.cmdUnequip(p, msg.slot);
                break;
            case 'autoHunt':
                world.cmdAutoHunt(p, !!msg.on);
                break;
            case 'pickup':
                world.cmdPickup(p, str(msg.id, 20) ? msg.id : undefined);
                break;
            case 'sortInv':
                sys.sortInv(p);
                break;
            case 'discard':
                if (int(msg.uid))
                    sys.discard(p, msg.uid);
                break;
            case 'learnSkill':
                if (str(msg.skillId))
                    world.cmdLearn(p, msg.skillId);
                break;
            case 'talk':
                if (str(msg.npc))
                    world.cmdTalk(p, msg.npc);
                break;
            case 'shopBuy':
                if (str(msg.npc) && str(msg.key) && int(msg.qty))
                    sys.shopBuy(p, msg.npc, msg.key, msg.qty);
                break;
            case 'shopSell':
                if (int(msg.uid) && int(msg.qty))
                    sys.shopSell(p, msg.uid, msg.qty);
                break;
            case 'enhance':
                if (int(msg.uid))
                    sys.enhance(p, msg.uid, !!msg.bless, !!msg.guard);
                break;
            case 'pk':
                world.cmdPk(p, !!msg.on);
                break;
            case 'advance':
                feat.advance(p);
                break;
            case 'craft':
                if (str(msg.id))
                    feat.craft(p, msg.id, int(msg.n) ? msg.n : 1);
                break;
            case 'whList':
                feat.whList(p);
                break;
            case 'whPut':
                feat.whPut(p, int(msg.uid) ? msg.uid : -1, int(msg.qty) ? msg.qty : 1, int(msg.gold) ? msg.gold : 0);
                break;
            case 'whTake':
                feat.whTake(p, int(msg.idx) ? msg.idx : -1, int(msg.qty) ? msg.qty : 1, int(msg.gold) ? msg.gold : 0);
                break;
            case 'guildCreate':
                if (str(msg.name, 8) && str(msg.tag, 3))
                    feat.guildCreate(p, msg.name, msg.tag);
                break;
            case 'guildInvite':
                if (str(msg.name, 12))
                    feat.guildInvite(p, msg.name);
                break;
            case 'guildRespond':
                feat.guildRespond(p, !!msg.accept);
                break;
            case 'guildLeave':
                feat.guildLeave(p);
                break;
            case 'guildKick':
                if (str(msg.name, 12))
                    feat.guildKick(p, msg.name);
                break;
            case 'guildInfo':
                feat.guildInfo(p);
                break;
            case 'dailyQuestClaim':
                if (str(msg.id))
                    feat.dailyQuestClaim(p, msg.id);
                break;
            case 'gm':
                if (str(msg.line, 120))
                    feat.gm(p, msg.line);
                break;
            case 'teleport':
                if (int(msg.idx))
                    sys.teleport(p, msg.idx);
                break;
            case 'questAccept':
                if (str(msg.id))
                    sys.questAccept(p, msg.id);
                break;
            case 'questTurnIn':
                if (str(msg.id))
                    sys.questTurnIn(p, msg.id);
                break;
            case 'questAbandon':
                if (str(msg.id))
                    sys.questAbandon(p, msg.id);
                break;
            case 'chat':
                if (CHAT_CHANNELS.includes(msg.ch) && str(msg.text, 200))
                    sys.say(p, msg.ch, msg.text);
                break;
            case 'partyInvite':
                if (str(msg.name, 12))
                    sys.partyInvite(p, msg.name);
                break;
            case 'partyRespond':
                sys.partyRespond(p, !!msg.accept);
                break;
            case 'partyLeave':
                sys.partyLeave(p);
                break;
            case 'partyKick':
                if (str(msg.name, 12))
                    sys.partyKick(p, msg.name);
                break;
            case 'tradeRequest':
                if (str(msg.name, 12))
                    sys.tradeRequest(p, msg.name);
                break;
            case 'tradeRespond':
                sys.tradeRespond(p, !!msg.accept);
                break;
            case 'tradeOffer':
                if (Array.isArray(msg.items) && msg.items.length <= 12 && msg.items.every(e => Array.isArray(e) && e.length === 2 && int(e[0]) && int(e[1])) && num(msg.gold ?? 0))
                    sys.tradeOffer(p, msg.items, Number(msg.gold ?? 0));
                break;
            case 'tradeLock':
                sys.tradeLock(p);
                break;
            case 'tradeConfirm':
                sys.tradeConfirm(p);
                break;
            case 'tradeCancel':
                sys.cancelTrade(p, '對方取消了交易');
                break;
            case 'dailyClaim':
                sys.dailyClaim(p);
                break;
            case 'settings':
                if (msg.s && typeof msg.s === 'object')
                    sys.settings(p, msg.s);
                break;
            case 'respawn':
                world.respawn(p);
                break;
            case 'recall':
                world.cmdRecall(p);
                break;
            case 'ping':
                conn.send({ t: 'pong', t0: num(msg.t0) ? msg.t0 : 0, now: Date.now() });
                break;
        }
    });
    ws.on('close', () => {
        clearTimeout(authTimer);
        // 只有目前這條連線擁有角色時才登出（避免踢人後誤刪新連線）
        if (charId !== null && world.players.get(charId)?.conn === conn)
            world.leave(charId);
    });
    ws.on('error', () => { });
}
world.start();
setInterval(() => sys.partyTick(), 1000);
server.listen(PORT, () => console.log(`星砂放置錄 v${VERSION} 伺服器啟動：http://localhost:${PORT}`));
const shutdown = () => { console.log('關閉中，存檔…'); world.stop(); db.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
