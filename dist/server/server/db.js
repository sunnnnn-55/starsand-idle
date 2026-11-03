import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
export function openDb(file) {
    if (file !== ':memory:')
        mkdirSync(dirname(file), { recursive: true });
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      pass_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS characters (
      id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      slot INTEGER NOT NULL, name TEXT NOT NULL UNIQUE COLLATE NOCASE, job TEXT NOT NULL,
      level INTEGER NOT NULL DEFAULT 1, exp INTEGER NOT NULL DEFAULT 0,
      hp INTEGER NOT NULL, mp INTEGER NOT NULL, gold INTEGER NOT NULL DEFAULT 0,
      map TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL, auto_hunt INTEGER NOT NULL DEFAULT 0,
      inventory TEXT NOT NULL DEFAULT '[]', equipment TEXT NOT NULL DEFAULT '{}',
      last_seen INTEGER, created_at INTEGER NOT NULL, UNIQUE(account_id, slot));
    CREATE INDEX IF NOT EXISTS idx_char_level ON characters(level DESC, exp DESC);
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY, char_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      loc TEXT NOT NULL CHECK (loc IN ('inv','eq')), slot TEXT NOT NULL, ord INTEGER NOT NULL DEFAULT 0,
      key TEXT NOT NULL, qty INTEGER NOT NULL DEFAULT 1, rarity INTEGER NOT NULL DEFAULT 0, affixes TEXT, enh INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS idx_items_char ON items(char_id, loc);
  `);
    // v2 欄位遷移
    const cols = new Set(db.prepare('PRAGMA table_info(characters)').all().map(c => c.name));
    const add = (n, def) => { if (!cols.has(n))
        db.exec(`ALTER TABLE characters ADD COLUMN ${n} ${def}`); };
    add('skills', "TEXT NOT NULL DEFAULT '{}'");
    add('quests', "TEXT NOT NULL DEFAULT '{}'");
    add('settings', "TEXT NOT NULL DEFAULT '{}'");
    add('daily', "TEXT NOT NULL DEFAULT '{}'");
    add('achievements', "TEXT NOT NULL DEFAULT '{}'");
    add('stats', "TEXT NOT NULL DEFAULT '{}'");
    add('migrated', 'INTEGER NOT NULL DEFAULT 0');
    // 把舊版 JSON 欄位的背包/裝備搬進 items 表
    const old = db.prepare("SELECT id, inventory, equipment FROM characters WHERE migrated = 0").all();
    if (old.length)
        db.transaction(() => {
            for (const o of old) {
                let inv = [], eq = {};
                try {
                    inv = JSON.parse(o.inventory);
                    eq = JSON.parse(o.equipment);
                }
                catch { /* 壞資料直接略過 */ }
                inv = Array.isArray(inv) ? inv.filter(i => i && typeof i.uid === 'number') : [];
                // 舊版裝備欄存的是 uid → 轉成物品實例並從背包移除
                const eqItems = {};
                for (const [s, v] of Object.entries(eq ?? {})) {
                    if (typeof v === 'number') {
                        const at = inv.findIndex(i => i.uid === v);
                        if (at >= 0 && s !== 'accessory')
                            eqItems[s] = inv.splice(at, 1)[0];
                    }
                    else if (v && typeof v === 'object')
                        eqItems[s] = v;
                }
                eq = eqItems;
                saveItems(db, o.id, Array.isArray(inv) ? inv : [], eq && typeof eq === 'object' ? eq : {});
                db.prepare("UPDATE characters SET migrated = 1, inventory = '[]', equipment = '{}' WHERE id = ?").run(o.id);
            }
        })();
    return db;
}
export function maxItemId(db) { return db.prepare('SELECT MAX(id) m FROM items').get().m ?? 0; }
const rowToItem = (r) => { const i = { uid: r.id, key: r.key, qty: r.qty }; if (r.rarity)
    i.r = r.rarity; if (r.affixes)
    i.aff = JSON.parse(r.affixes); if (r.enh)
    i.enh = r.enh; return i; };
export function loadItems(db, charId) {
    const rows = db.prepare('SELECT * FROM items WHERE char_id = ? ORDER BY ord').all(charId);
    const inv = [], eq = {};
    for (const r of rows)
        if (r.loc === 'inv')
            inv.push(rowToItem(r));
        else
            eq[r.slot] = rowToItem(r);
    return { inv, eq };
}
/** 以角色為單位整批覆寫（呼叫端放在 transaction 內） */
export function saveItems(db, charId, inv, eq) {
    db.prepare('DELETE FROM items WHERE char_id = ?').run(charId);
    const ins = db.prepare('INSERT INTO items (id, char_id, loc, slot, ord, key, qty, rarity, affixes, enh) VALUES (?,?,?,?,?,?,?,?,?,?)');
    inv.forEach((i, n) => ins.run(i.uid, charId, 'inv', 'bag', n, i.key, i.qty, i.r ?? 0, i.aff?.length ? JSON.stringify(i.aff) : null, i.enh ?? 0));
    for (const [s, i] of Object.entries(eq))
        if (i)
            ins.run(i.uid, charId, 'eq', s, 0, i.key, i.qty, i.r ?? 0, i.aff?.length ? JSON.stringify(i.aff) : null, i.enh ?? 0);
}
