import { addItem, canAdd, countItem, INV_MAX, removeItem, taipeiDay } from '../shared/rules.js';
const GUILD_COST = 10000, GUILD_LV = 20, GUILD_MAX = 30, WH_MAX = 80;
const dayNum = () => Number(taipeiDay(Date.now()).replace(/-/g, ''));
export function migrateFeatures(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS guilds (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, tag TEXT NOT NULL, leader INTEGER NOT NULL, notice TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS guild_members (char_id INTEGER PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE, guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE, rank INTEGER NOT NULL DEFAULT 0, joined_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS warehouse (account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE, items TEXT NOT NULL DEFAULT '[]', gold INTEGER NOT NULL DEFAULT 0);
  `);
}
export class Features {
    w;
    sys;
    gmNames;
    guildInvites = new Map();
    constructor(w, sys, gmNames) {
        this.w = w;
        this.sys = sys;
        this.gmNames = gmNames;
        migrateFeatures(w.db);
        w.hooks.guildOf = id => this.guildOf(id);
        w.hooks.onPlayerKilled = (v, k) => this.onPlayerKilled(v, k);
        w.hooks.onDaily = (p, kind, n = 1) => this.bump(p, kind, n);
        const prevKill = w.hooks.onKill;
        w.hooks.onKill = (p, m) => {
            prevKill?.(p, m);
            this.bump(p, 'kills');
            if (this.w.c.monsters[m].rank)
                this.bump(p, 'boss');
            // 罪業每擊敗 50 隻怪物減 1
            if ((p.counters.sin ?? 0) > 0) {
                p.counters.sinKills = (p.counters.sinKills ?? 0) + 1;
                if (p.counters.sinKills >= 50) {
                    p.counters.sinKills = 0;
                    p.counters.sin--;
                    p.selfDirty = true;
                    if (!p.counters.sin)
                        this.w.log(p, '罪業已洗清，名字恢復正常', 'good');
                }
            }
        };
    }
    get c() { return this.w.c; }
    get db() { return this.w.db; }
    // ---------- 對話選項 ----------
    dialogOpts(p, npcId) {
        const n = this.c.npcs[npcId], o = {};
        if (n.advance) {
            const cls = this.c.classes[p.job], st = p.counters.adv ?? 0;
            o.advance = { stage: st, steps: (cls.adv ?? []).map((a, i) => ({ ...a, itemName: this.c.items[a.item]?.name, have: countItem(p.inv, a.item) > 0, done: i < st })) };
        }
        if (n.craft)
            o.craft = Object.entries(this.c.recipes).map(([id, r]) => ({ id, ...r, outName: this.c.items[r.out].name, icon: this.c.items[r.out].icon, mats: r.mats.map(([k, q]) => [k, q, this.c.items[k].name, countItem(p.inv, k)]) }));
        if (n.warehouse)
            o.warehouse = true;
        if (n.guild)
            o.guild = this.guildView(p);
        if (n.daily)
            o.daily = this.dailyView(p);
        return o;
    }
    // ---------- 轉職 / 覺醒 ----------
    advance(p) {
        if (!this.w.nearNpc(p, k => !!this.c.npcs[k].advance))
            return;
        const cls = this.c.classes[p.job], st = p.counters.adv ?? 0, a = cls.adv?.[st];
        if (!a) {
            this.w.log(p, '你已完成所有進階', 'warn');
            return;
        }
        if (p.level < a.lv) {
            this.w.log(p, `需要等級 ${a.lv}`, 'warn');
            return;
        }
        if (countItem(p.inv, a.item) < 1) {
            this.w.log(p, `需要「${this.c.items[a.item].name}」`, 'warn');
            return;
        }
        if (p.gold < a.gold) {
            this.w.log(p, `需要 ${a.gold} 金幣`, 'warn');
            return;
        }
        removeItem(p.inv, a.item, 1);
        p.gold -= a.gold;
        p.counters.adv = st + 1;
        this.w.refreshStats(p);
        p.hp = p.stats.maxHp;
        p.mp = p.stats.maxMp;
        this.w.markAll(p);
        this.w.emit(this.w.mapOf(p), { e: 'lvl', id: p.id, lv: p.level }, p.x, p.y);
        this.w.toast(p, `${st === 0 ? '轉職' : '覺醒'}成功！你成為了「${a.name}」，全屬性 ×${a.mult}`, 'ach');
        this.sys.system(`${p.name} ${st === 0 ? '完成轉職' : '完成覺醒'}，成為「${a.name}」！`);
        this.w.saveOne(p);
        this.sys.dialog(p, this.w.nearNpc(p, k => !!this.c.npcs[k].advance).npc);
    }
    // ---------- 製作 ----------
    craft(p, id, times = 1) {
        const r = this.c.recipes[id];
        if (!r || !this.w.nearNpc(p, k => !!this.c.npcs[k].craft))
            return;
        if (p.tradeId !== null)
            return;
        if (p.level < r.level) {
            this.w.log(p, `需要等級 ${r.level}`, 'warn');
            return;
        }
        times = Math.max(1, Math.min(20, Math.floor(times)));
        let made = 0;
        for (let i = 0; i < times; i++) {
            if (p.gold < r.gold || !r.mats.every(([k, q]) => countItem(p.inv, k) >= q))
                break;
            if (!canAdd(p.inv, this.c.items, { key: r.out, qty: r.qty })) {
                this.w.log(p, '背包已滿', 'warn');
                break;
            }
            p.gold -= r.gold;
            for (const [k, q] of r.mats)
                removeItem(p.inv, k, q);
            addItem(p.inv, this.c.items, r.out, r.qty);
            made++;
        }
        if (!made) {
            this.w.log(p, '材料或金幣不足', 'warn');
            return;
        }
        this.bump(p, 'craft', made);
        this.w.markAll(p);
        this.w.toast(p, `製作完成：${this.c.items[r.out].name} ×${r.qty * made}`, 'good');
        this.w.saveOne(p);
        p.conn.send({ t: 'crafted', id, n: made });
    }
    // ---------- 倉庫（帳號共用） ----------
    whLoad(acc) {
        const row = this.db.prepare('SELECT items, gold FROM warehouse WHERE account_id=?').get(acc);
        if (!row)
            return { items: [], gold: 0 };
        try {
            return { items: JSON.parse(row.items), gold: row.gold };
        }
        catch {
            return { items: [], gold: row.gold };
        }
    }
    whSave(acc, wh) {
        this.db.prepare('INSERT INTO warehouse (account_id, items, gold) VALUES (?,?,?) ON CONFLICT(account_id) DO UPDATE SET items=excluded.items, gold=excluded.gold').run(acc, JSON.stringify(wh.items), wh.gold);
    }
    whList(p) { p.conn.send({ t: 'warehouse', ...this.whLoad(p.accountId), max: WH_MAX }); }
    whPut(p, uid, qty, gold = 0) {
        if (!this.w.nearNpc(p, k => !!this.c.npcs[k].warehouse) || p.tradeId !== null)
            return;
        const wh = this.whLoad(p.accountId);
        if (gold > 0) {
            gold = Math.min(p.gold, Math.floor(gold));
            p.gold -= gold;
            wh.gold += gold;
        }
        const it = p.inv.find(i => i.uid === uid);
        if (it) {
            const d = this.c.items[it.key];
            if (d.type === 'quest') {
                this.w.log(p, '任務物品無法存入倉庫', 'warn');
                return;
            }
            qty = Math.max(1, Math.min(it.qty, Math.floor(qty)));
            const same = d.stack ? wh.items.find(i => i.key === it.key && !i.r && !i.enh) : undefined;
            if (!same && wh.items.length >= WH_MAX) {
                this.w.log(p, '倉庫已滿', 'warn');
                return;
            }
            if (same)
                same.qty += qty;
            else
                wh.items.push({ ...it, qty });
            it.qty -= qty;
            if (it.qty <= 0)
                p.inv.splice(p.inv.indexOf(it), 1);
        }
        this.db.transaction(() => { this.whSave(p.accountId, wh); this.w.saveOne(p); })();
        this.w.markAll(p);
        this.whList(p);
    }
    whTake(p, idx, qty, gold = 0) {
        if (!this.w.nearNpc(p, k => !!this.c.npcs[k].warehouse) || p.tradeId !== null)
            return;
        const wh = this.whLoad(p.accountId);
        if (gold > 0) {
            gold = Math.min(wh.gold, Math.floor(gold));
            wh.gold -= gold;
            p.gold += gold;
        }
        const it = wh.items[idx];
        if (it) {
            qty = Math.max(1, Math.min(it.qty, Math.floor(qty)));
            if (!canAdd(p.inv, this.c.items, { key: it.key, qty })) {
                this.w.log(p, '背包已滿', 'warn');
                return;
            }
            addItem(p.inv, this.c.items, it.key, qty, { r: it.r, aff: it.aff, enh: it.enh });
            it.qty -= qty;
            if (it.qty <= 0)
                wh.items.splice(idx, 1);
        }
        this.db.transaction(() => { this.whSave(p.accountId, wh); this.w.saveOne(p); })();
        this.w.markAll(p);
        this.whList(p);
    }
    // ---------- 誓盟 ----------
    guildOf(charId) {
        const r = this.db.prepare('SELECT g.id, g.tag, g.name, m.rank FROM guild_members m JOIN guilds g ON g.id = m.guild_id WHERE m.char_id = ?').get(charId);
        return r ?? null;
    }
    guildView(p) {
        if (!p.guild)
            return { none: true, cost: GUILD_COST, lv: GUILD_LV };
        const g = this.db.prepare('SELECT * FROM guilds WHERE id=?').get(p.guild.id);
        const members = this.db.prepare('SELECT c.id, c.name, c.job, c.level, m.rank FROM guild_members m JOIN characters c ON c.id = m.char_id WHERE m.guild_id=? ORDER BY m.rank DESC, c.level DESC').all(p.guild.id)
            .map(m => ({ ...m, online: this.w.players.has(m.id) }));
        return { name: g.name, tag: g.tag, notice: g.notice, leader: g.leader === p.charId, members, max: GUILD_MAX };
    }
    refreshGuild(gid) { for (const o of this.w.players.values())
        if (o.guild?.id === gid || this.guildOf(o.charId)?.id === gid) {
            o.guild = this.guildOf(o.charId);
            o.selfDirty = true;
            o.known.clear();
        } }
    guildCreate(p, name, tag) {
        if (!this.w.nearNpc(p, k => !!this.c.npcs[k].guild))
            return;
        name = String(name).trim();
        tag = String(tag).trim();
        if (p.guild) {
            this.w.log(p, '你已加入誓盟', 'warn');
            return;
        }
        if (p.level < GUILD_LV) {
            this.w.log(p, `需要等級 ${GUILD_LV}`, 'warn');
            return;
        }
        if (p.gold < GUILD_COST) {
            this.w.log(p, `需要 ${GUILD_COST} 金幣`, 'warn');
            return;
        }
        if (!/^[\p{L}\p{N}]{2,8}$/u.test(name) || !/^[\p{L}\p{N}]{1,3}$/u.test(tag)) {
            this.w.log(p, '誓盟名稱 2~8 字、標記 1~3 字（僅文字與數字）', 'warn');
            return;
        }
        if (this.db.prepare('SELECT 1 FROM guilds WHERE name=?').get(name)) {
            this.w.log(p, '此名稱已被使用', 'warn');
            return;
        }
        this.db.transaction(() => {
            const r = this.db.prepare('INSERT INTO guilds (name, tag, leader, created_at) VALUES (?,?,?,?)').run(name, tag, p.charId, Date.now());
            this.db.prepare('INSERT INTO guild_members (char_id, guild_id, rank, joined_at) VALUES (?,?,2,?)').run(p.charId, r.lastInsertRowid, Date.now());
            p.gold -= GUILD_COST;
            this.w.saveOne(p);
        })();
        p.guild = this.guildOf(p.charId);
        this.w.markAll(p);
        p.known.clear();
        this.sys.system(`${p.name} 建立了誓盟「${name}」！`);
        this.guildInfo(p);
    }
    guildInvite(p, name) {
        if (!p.guild || p.guild.rank < 1) {
            this.w.log(p, '只有盟主/幹部能邀請', 'warn');
            return;
        }
        const o = this.w.byName(name);
        if (!o || o === p) {
            this.w.log(p, '找不到該玩家（需在線上）', 'warn');
            return;
        }
        if (o.guild) {
            this.w.log(p, `${o.name} 已有誓盟`, 'warn');
            return;
        }
        const n = this.db.prepare('SELECT COUNT(*) n FROM guild_members WHERE guild_id=?').get(p.guild.id).n;
        if (n >= GUILD_MAX) {
            this.w.log(p, '誓盟人數已滿', 'warn');
            return;
        }
        this.guildInvites.set(o.charId, { from: p.charId, guild: p.guild.id, at: Date.now() });
        o.conn.send({ t: 'invite', kind: 'guild', from: p.name, fromId: p.charId, guild: p.guild.name });
        this.w.log(p, `已邀請 ${o.name} 加入誓盟`);
    }
    guildRespond(p, accept) {
        const inv = this.guildInvites.get(p.charId);
        this.guildInvites.delete(p.charId);
        if (!inv || Date.now() - inv.at > 60000 || !accept || p.guild)
            return;
        this.db.prepare('INSERT OR IGNORE INTO guild_members (char_id, guild_id, rank, joined_at) VALUES (?,?,0,?)').run(p.charId, inv.guild, Date.now());
        this.refreshGuild(inv.guild);
        this.guildSay(inv.guild, `${p.name} 加入了誓盟`);
    }
    guildLeave(p) {
        if (!p.guild)
            return;
        const gid = p.guild.id;
        const isLeader = p.guild.rank >= 2;
        this.db.transaction(() => {
            this.db.prepare('DELETE FROM guild_members WHERE char_id=?').run(p.charId);
            if (isLeader) {
                const next = this.db.prepare('SELECT char_id FROM guild_members WHERE guild_id=? ORDER BY rank DESC, joined_at LIMIT 1').get(gid);
                if (next) {
                    this.db.prepare('UPDATE guild_members SET rank=2 WHERE char_id=?').run(next.char_id);
                    this.db.prepare('UPDATE guilds SET leader=? WHERE id=?').run(next.char_id, gid);
                }
                else
                    this.db.prepare('DELETE FROM guilds WHERE id=?').run(gid);
            }
        })();
        p.guild = null;
        p.selfDirty = true;
        p.known.clear();
        this.refreshGuild(gid);
        this.guildSay(gid, `${p.name} 離開了誓盟`);
        this.w.log(p, '已離開誓盟');
    }
    guildKick(p, name) {
        if (!p.guild || p.guild.rank < 2)
            return;
        const row = this.db.prepare('SELECT m.char_id FROM guild_members m JOIN characters c ON c.id=m.char_id WHERE m.guild_id=? AND c.name=?').get(p.guild.id, name);
        if (!row || row.char_id === p.charId)
            return;
        this.db.prepare('DELETE FROM guild_members WHERE char_id=?').run(row.char_id);
        const o = this.w.players.get(row.char_id);
        if (o) {
            o.guild = null;
            o.selfDirty = true;
            o.known.clear();
            this.w.log(o, '你被移出了誓盟', 'warn');
        }
        this.refreshGuild(p.guild.id);
        this.guildSay(p.guild.id, `${name} 被移出誓盟`);
    }
    guildInfo(p) { p.conn.send({ t: 'guild', info: this.guildView(p) }); }
    guildSay(gid, text, from = '誓盟') { for (const o of this.w.players.values())
        if (o.guild?.id === gid)
            o.conn.send({ t: 'chat', ch: 'guild', from, text, ts: Date.now() }); }
    // ---------- 每日懸賞 ----------
    dayReset(p) {
        const d = dayNum();
        if (p.counters.dday === d)
            return;
        for (const k of Object.keys(p.counters))
            if (k.startsWith('dq_') || k.startsWith('dc_'))
                delete p.counters[k];
        p.counters.dday = d;
    }
    bump(p, kind, n = 1) {
        this.dayReset(p);
        for (const [id, dq] of Object.entries(this.c.dailies))
            if (dq.kind === kind && !p.counters['dc_' + id]) {
                const before = p.counters['dq_' + id] ?? 0;
                p.counters['dq_' + id] = before + n;
                if (before < dq.n && before + n >= dq.n)
                    this.w.toast(p, `每日懸賞達成：${dq.name}（至懸賞官領取）`, 'good');
            }
        p.progDirty = true;
    }
    dailyView(p) { this.dayReset(p); return Object.entries(this.c.dailies).map(([id, d]) => ({ id, ...d, cur: Math.min(d.n, p.counters['dq_' + id] ?? 0), claimed: !!p.counters['dc_' + id], itemNames: (d.items ?? []).map(([k, q]) => `${this.c.items[k].name}×${q}`) })); }
    dailyQuestClaim(p, id) {
        const d = this.c.dailies[id];
        if (!d || !this.w.nearNpc(p, k => !!this.c.npcs[k].daily))
            return;
        this.dayReset(p);
        if (p.counters['dc_' + id]) {
            this.w.log(p, '今天已領取', 'warn');
            return;
        }
        if ((p.counters['dq_' + id] ?? 0) < d.n) {
            this.w.log(p, '尚未達成', 'warn');
            return;
        }
        if (p.inv.length + (d.items?.length ?? 0) > INV_MAX) {
            this.w.log(p, '背包已滿', 'warn');
            return;
        }
        p.counters['dc_' + id] = 1;
        p.gold += d.gold;
        for (const [k, q] of d.items ?? [])
            addItem(p.inv, this.c.items, k, q);
        this.w.markAll(p);
        this.w.toast(p, `領取懸賞：${d.name}（+${d.gold} 金幣）`, 'good');
        this.w.saveOne(p);
        this.sys.dialog(p, this.w.nearNpc(p, k => !!this.c.npcs[k].daily).npc);
    }
    // ---------- PK：罪業 / 榮譽 ----------
    onPlayerKilled(v, k) {
        if (!k || k === v)
            return;
        const pvpMap = !!this.w.mapOf(v).def.pvp;
        if (this.w.isRed(v)) {
            k.counters.honor = (k.counters.honor ?? 0) + 5;
            this.w.toast(k, `討伐紅名玩家 ${v.name}，榮譽值 +5`, 'good');
        }
        else if (!pvpMap && this.w.now >= v.aggrUntil) {
            k.counters.sin = (k.counters.sin ?? 0) + 3;
            k.counters.pkills = (k.counters.pkills ?? 0) + 1;
            this.w.toast(k, `你擊倒了無辜的 ${v.name}，罪業 +3（名字變紅，死亡掉落率提高）`, 'bad');
            this.sys.system(`${k.name} 在 ${this.w.mapOf(k).def.name} 擊倒了 ${v.name}，背負了罪業！`);
        }
        k.selfDirty = k.progDirty = k.saveDirty = true;
        k.known.clear();
        k.targetId = null;
    }
    // ---------- GM 指令（僅限 GM_NAMES 環境變數列出的角色） ----------
    gm(p, line) {
        if (!this.gmNames.has(p.name.toLowerCase())) {
            this.w.log(p, '你沒有 GM 權限', 'warn');
            return;
        }
        const [cmd, ...a] = String(line).trim().split(/\s+/);
        const ok = (t) => this.w.log(p, '[GM] ' + t, 'good');
        switch (cmd) {
            case 'level': {
                const lv = Math.max(1, Math.min(60, Number(a[0]) || 1));
                p.level = lv;
                p.exp = 0;
                this.w.refreshStats(p);
                p.hp = p.stats.maxHp;
                this.w.markAll(p);
                ok(`等級設為 ${lv}`);
                break;
            }
            case 'gold':
                p.gold += Math.max(0, Number(a[0]) || 0);
                this.w.markAll(p);
                ok('金幣已增加');
                break;
            case 'item': {
                const k = a[0], q = Math.max(1, Number(a[1]) || 1);
                if (!this.c.items[k]) {
                    this.w.log(p, '無此物品');
                    break;
                }
                addItem(p.inv, this.c.items, k, q);
                this.w.markAll(p);
                ok(`獲得 ${this.c.items[k].name} ×${q}`);
                break;
            }
            case 'tp': {
                const m = this.c.maps[a[0]];
                if (!m) {
                    this.w.log(p, '可用地圖：' + Object.keys(this.c.maps).join(' '));
                    break;
                }
                this.w.travel(p, m.id, m.spawn.x + 0.5, m.spawn.y + 0.5);
                break;
            }
            case 'adv':
                p.counters.adv = Math.max(0, Math.min(2, Number(a[0]) || 0));
                this.w.refreshStats(p);
                this.w.markAll(p);
                ok(`進階階段 ${p.counters.adv}`);
                break;
            case 'heal':
                p.hp = p.stats.maxHp;
                p.mp = p.stats.maxMp;
                p.selfDirty = true;
                ok('已補滿');
                break;
            case 'sin':
                p.counters.sin = Math.max(0, Number(a[0]) || 0);
                p.selfDirty = true;
                p.known.clear();
                ok(`罪業 ${p.counters.sin}`);
                break;
            case 'boss':
                this.w.respawnBosses();
                ok('所有首領已重生');
                break;
            case 'say':
                this.sys.system(a.join(' '));
                break;
            default: this.w.log(p, 'GM：level N｜gold N｜item key [n]｜tp map｜adv 0-2｜heal｜sin N｜boss｜say 文字');
        }
        this.w.saveOne(p);
    }
}
