import { SLOTS } from '../shared/types.js';
import { addItem, applyExp, canAdd, computeDamage, computeStats, deathPenalty, expToNext, finalizeLoot, isGear, partyShare, rollDrops, rollGold, settleOffline, skillBuffPct, skillMult, skillPointsFor } from '../shared/rules.js';
import { WalkGrid, findPath } from '../shared/path.js';
import { dirFromScreen } from '../shared/iso.js';
import { loadItems, saveItems } from './db.js';
export const TICK_MS = 100;
export const AOI_RADIUS = 18;
const CELL = 8;
const UNSTUCK_MS = 10000;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const r2 = (n) => Math.round(n * 100) / 100;
/** 世界座標向量 → 8 方向（0=南 … 順時針，以螢幕方向計） */
export function dirOf(dx, dy) { return dirFromScreen(dx - dy, (dx + dy) * 0.5); }
export const DEFAULT_SETTINGS = { autoPickup: true, autoPotionPct: 45, autoSkills: true, pickupRare: true };
export class World {
    c;
    db;
    rng;
    maps = new Map();
    players = new Map();
    bossTimers = new Map();
    seq = 0;
    timer = null;
    lastSave = 0;
    now = Date.now();
    /** 由 social/economy 掛上的回呼 */
    hooks = {};
    constructor(c, db, rng = Math.random) {
        this.c = c;
        this.db = db;
        this.rng = rng;
        for (const def of Object.values(c.maps)) {
            const cells = new Uint8Array(def.width * def.height);
            def.rows.forEach((row, y) => [...row].forEach((ch, x) => { cells[y * def.width + x] = def.legend[ch].walk ? 1 : 0; }));
            const inst = { def, grid: new WalkGrid(def.width, def.height, cells), players: new Set(), monsters: new Map(), loot: new Map(), events: [] };
            this.maps.set(def.id, inst);
            for (const sp of def.spawns)
                for (let i = 0; i < sp.count; i++)
                    this.spawnMonster(inst, sp.monster, sp.area);
        }
    }
    start() { this.timer = setInterval(() => this.tick(Date.now()), TICK_MS); }
    stop() { if (this.timer)
        clearInterval(this.timer); this.saveAll(); }
    mapOf(p) { return this.maps.get(p.mapId); }
    byName(name) { for (const p of this.players.values())
        if (p.name.toLowerCase() === String(name).toLowerCase())
            return p; return undefined; }
    byId(id) { const n = Number(String(id).slice(1)); const p = this.players.get(n); return p && p.id === id ? p : undefined; }
    emit(inst, ev, x, y) { inst.events.push({ ev, x, y }); }
    // ---------------- 生成 ----------------
    randomWalkable(inst, area) {
        for (let i = 0; i < 80; i++) {
            const x = area[0] + Math.floor(this.rng() * (area[2] - area[0] + 1)), y = area[1] + Math.floor(this.rng() * (area[3] - area[1] + 1));
            if (inst.grid.ok(x, y))
                return { x: x + 0.5, y: y + 0.5 };
        }
        return { x: inst.def.spawn.x + 0.5, y: inst.def.spawn.y + 0.5 };
    }
    nearestWalkable(inst, x, y) {
        for (let r = 0; r < 8; r++)
            for (let dy = -r; dy <= r; dy++)
                for (let dx = -r; dx <= r; dx++)
                    if (inst.grid.ok(Math.floor(x) + dx, Math.floor(y) + dy))
                        return { x: Math.floor(x) + dx + 0.5, y: Math.floor(y) + dy + 0.5 };
        return { x: inst.def.spawn.x + 0.5, y: inst.def.spawn.y + 0.5 };
    }
    spawnMonster(inst, key, area) {
        const d = this.c.monsters[key], p = this.randomWalkable(inst, area);
        const m = { id: 'm' + ++this.seq, key, mapId: inst.def.id, area, x: p.x, y: p.y, homeX: p.x, homeY: p.y, path: [], dest: null, dir: Math.floor(this.rng() * 8), act: 'idle', actUntil: 0, aseq: 0,
            hp: d.hp, maxHp: d.hp, targetId: null, atkReady: 0, deadUntil: 0, goneAt: 0, wanderAt: this.now + this.rng() * 4000, repathAt: 0, slowUntil: 0, dots: [], dmgBy: new Map() };
        inst.monsters.set(m.id, m);
        if (d.rank) {
            this.bossTimers.set(key, { monster: key, map: inst.def.id, alive: true, at: 0 });
            this.broadcastBossTimers();
        }
    }
    /** GM：立即重生所有已死亡的首領 */
    respawnBosses() { for (const inst of this.maps.values())
        for (const m of inst.monsters.values())
            if (m.deadUntil && this.c.monsters[m.key].rank)
                m.deadUntil = this.now; }
    bossTimerList() { return [...this.bossTimers.values()]; }
    broadcastBossTimers() { const list = this.bossTimerList(); for (const p of this.players.values())
        p.conn.send({ t: 'bossTimers', list, now: this.now }); }
    // ---------------- 角色 ----------------
    statsOf(p) {
        const st = computeStats(this.c.classes[p.job], p.level, SLOTS.map(s => { const i = p.eq[s]; return i ? { def: this.c.items[i.key], inst: i } : undefined; }), p.buffs, this.now);
        const stage = p.counters?.adv ?? 0, adv = this.c.classes[p.job].adv?.[stage - 1];
        if (adv) {
            st.atk = Math.round(st.atk * adv.mult);
            st.def = Math.round(st.def * adv.mult);
            st.maxHp = Math.round(st.maxHp * adv.mult);
            st.maxMp = Math.round(st.maxMp * adv.mult);
        }
        return st;
    }
    advStage(p) { return p.counters.adv ?? 0; }
    advName(p) { const s = this.advStage(p); return s ? this.c.classes[p.job].adv?.[s - 1]?.name : undefined; }
    /** 罪業值 > 0 = 紅名 */
    isRed(p) { return (p.counters.sin ?? 0) > 0; }
    skillPoints(p) { return skillPointsFor(p.level) - Object.values(p.skills).reduce((a, b) => a + b, 0); }
    join(row, conn) {
        const old = this.players.get(row.id);
        if (old) {
            old.conn.close(4001, 'other-login');
            this.leave(old.charId);
        }
        for (const p of this.players.values())
            if (p.accountId === row.account_id) {
                p.conn.close(4001, 'other-login');
                this.leave(p.charId);
            }
        const inst = this.maps.get(row.map) ?? this.maps.get(this.c.startMap);
        let { x, y } = row;
        if (!inst.grid.ok(Math.floor(x), Math.floor(y)))
            ({ x, y } = this.nearestWalkable(inst, x, y));
        const J = (s, d) => { try {
            const v = JSON.parse(s);
            return v && typeof v === 'object' ? { ...d, ...v } : d;
        }
        catch {
            return d;
        } };
        const items = loadItems(this.db, row.id);
        const p = {
            id: 'p' + row.id, charId: row.id, accountId: row.account_id, name: row.name, job: row.job, level: row.level, exp: row.exp, hp: row.hp, mp: row.mp, gold: row.gold,
            mapId: inst.def.id, x, y, path: [], dest: null, dir: 0, act: 'idle', actUntil: 0, aseq: 0,
            inv: items.inv, eq: items.eq, stats: null, autoHunt: !!row.auto_hunt,
            skills: J(row.skills, {}), quests: J(row.quests, { active: {}, done: [] }), settings: J(row.settings, DEFAULT_SETTINGS), daily: J(row.daily, { last: null, streak: 0 }),
            ach: J(row.achievements, { done: [] }), counters: J(row.stats, {}), buffs: [],
            targetId: null, pickId: null, talkNpc: null, atkReady: 0, skillReady: {}, potionReady: 0, pendingSkill: null, lastCombat: 0, deadUntil: 0, repathAt: 0, manual: false, ignore: new Map(),
            conn, selfDirty: true, invDirty: true, progDirty: true, saveDirty: false, regenAcc: 0, known: new Map(), partyId: null, tradeId: null,
            morph: null, pet: null, guild: null, pkOn: false, aggrUntil: 0,
        };
        for (const k of Object.keys(p.skills))
            if (!this.c.classes[p.job].skills.includes(k))
                delete p.skills[k];
        if (p.counters.pet && this.c.pets[String(p.counters.petKey ?? '')])
            p.pet = String(p.counters.petKey);
        p.guild = this.hooks.guildOf?.(p.charId) ?? null;
        p.stats = this.statsOf(p);
        let report = null;
        if (row.auto_hunt && row.last_seen && !inst.def.safe) {
            const r = settleOffline(this.c, { level: p.level, exp: p.exp, stats: p.stats, mapMonsters: inst.def.spawns.map(s => s.monster), seconds: (Date.now() - row.last_seen) / 1000, inv: p.inv }, this.rng);
            if (r.kills > 0) {
                p.level = r.level;
                p.exp = r.expAfter;
                p.gold += r.gold + r.soldGold;
                for (const l of r.loot)
                    if (!addItem(p.inv, this.c.items, l.key, l.qty, { r: l.r, aff: l.aff }))
                        p.gold += 0;
                p.counters.kills = (p.counters.kills ?? 0) + r.kills;
                p.stats = this.statsOf(p);
                report = { ...r, monsterName: r.monster ? this.c.monsters[r.monster].name : null, loot: r.loot.map(l => ({ ...l, name: this.c.items[l.key].name })) };
                p.hp = p.stats.maxHp;
                p.mp = p.stats.maxMp;
            }
        }
        p.hp = Math.min(Math.max(1, p.hp), p.stats.maxHp);
        p.mp = Math.min(p.mp, p.stats.maxMp);
        this.players.set(row.id, p);
        inst.players.add(p);
        conn.send({ t: 'welcome', you: p.id, serverTime: Date.now() });
        this.sendMap(p);
        this.flushSelf(p);
        conn.send({ t: 'bossTimers', list: this.bossTimerList(), now: this.now });
        if (report) {
            conn.send({ t: 'offlineReport', ...report });
            this.saveOne(p);
        }
        return p;
    }
    leave(charId) {
        const p = this.players.get(charId);
        if (!p)
            return;
        this.hooks.onLeave?.(p);
        this.saveOne(p);
        this.players.delete(charId);
        this.mapOf(p).players.delete(p);
        for (const m of this.mapOf(p).monsters.values())
            if (m.targetId === p.id)
                m.targetId = null;
    }
    kickChar(charId) { const p = this.players.get(charId); if (p) {
        p.conn.close(4001, 'deleted');
        this.leave(charId);
    } }
    // ---------------- 序列化 ----------------
    bodyTier(p) { const a = p.eq.armor; return a ? Math.min(2, this.c.items[a.key].tier ?? 0) : 0; }
    wpnTier(p) { const w = p.eq.weapon; return w ? Math.min(2, this.c.items[w.key].tier ?? 0) : -1; }
    viewP(e) {
        return { id: e.id, k: 'p', name: e.name, lv: e.level, x: r2(e.x), y: r2(e.y), hp: e.hp, mhp: e.stats.maxHp, spr: e.job, act: e.act, d: e.dir, job: e.job, body: this.bodyTier(e), wpn: this.wpnTier(e), aseq: e.aseq, spd: r2(e.stats.speed), party: e.partyId !== null,
            mo: e.morph ? this.c.morphs[e.morph]?.sprite : undefined, pet: e.pet ? this.c.pets[e.pet]?.sprite : undefined, gt: e.guild?.tag, pk: this.isRed(e) ? 2 : this.now < e.aggrUntil ? 1 : undefined, adv: this.advName(e), pko: e.pkOn || undefined };
    }
    viewM(e) {
        const d = this.c.monsters[e.key];
        return { id: e.id, k: 'm', name: d.name, lv: d.level, x: r2(e.x), y: r2(e.y), hp: e.hp, mhp: e.maxHp, spr: d.sprite, act: e.act, d: e.dir, rank: d.rank, aseq: e.aseq, key: e.key };
    }
    viewL(l) {
        const d = this.c.items[l.key];
        return { id: l.id, k: 'l', name: d.name, x: r2(l.x), y: r2(l.y), spr: 'loot', act: 'idle', r: l.r ?? 0, qty: l.qty, icon: d.icon, ow: this.now < l.ownerUntil ? 'p' + l.owner : undefined, key: l.key };
    }
    sendMap(p) {
        p.known.clear();
        const def = this.mapOf(p).def;
        p.conn.send({ t: 'map', mapId: p.mapId, name: def.name, npcs: def.npcs.map(n => ({ ...n, name: this.c.npcs[n.npc].name, title: this.c.npcs[n.npc].title, spr: this.c.npcs[n.npc].sprite })) });
    }
    flushSelf(p) {
        if (p.selfDirty) {
            const cds = {};
            for (const [k, v] of Object.entries(p.skillReady))
                if (v > this.now)
                    cds[k] = v - this.now;
            p.conn.send({ t: 'self', id: p.id, charId: p.charId, name: p.name, job: p.job, level: p.level, exp: p.exp, expNext: expToNext(p.level), hp: p.hp, mp: p.mp, gold: p.gold, map: p.mapId,
                stats: p.stats, online: this.players.size, autoHunt: p.autoHunt, targetId: p.targetId, cds, dead: p.deadUntil > 0 ? Math.max(0, p.deadUntil - this.now) : 0, x: r2(p.x), y: r2(p.y),
                buffs: p.buffs.filter(b => b.until > this.now).map(b => ({ skill: b.skill, left: b.until - this.now })),
                adv: this.advStage(p), advName: this.advName(p), sin: p.counters.sin ?? 0, honor: p.counters.honor ?? 0, pkOn: p.pkOn, morph: p.morph, pet: p.pet, guild: p.guild });
            p.selfDirty = false;
        }
        if (p.invDirty) {
            p.conn.send({ t: 'inv', inv: p.inv, eq: p.eq });
            p.invDirty = false;
        }
        if (p.progDirty) {
            p.conn.send({ t: 'prog', skills: p.skills, sp: this.skillPoints(p), quests: p.quests, settings: p.settings, daily: p.daily, ach: p.ach.done, counters: p.counters });
            p.progDirty = false;
        }
    }
    log(p, text, kind = 'info') { p.conn.send({ t: 'log', kind, text }); }
    toast(p, text, kind = 'info') { p.conn.send({ t: 'toast', kind, text }); }
    markAll(p) { p.selfDirty = p.invDirty = p.progDirty = p.saveDirty = true; }
    // ---------------- 指令 ----------------
    cmdMove(p, x, y) {
        if (p.deadUntil)
            return;
        const inst = this.mapOf(p);
        if (!inst.grid.ok(Math.floor(x), Math.floor(y))) {
            const n = this.nearestWalkable(inst, x, y);
            x = n.x;
            y = n.y;
        }
        const path = findPath(inst.grid, p.x, p.y, x, y, 6000);
        if (!path)
            return;
        p.targetId = null;
        p.pendingSkill = null;
        p.pickId = null;
        p.talkNpc = null;
        p.manual = true;
        p.path = path;
        p.dest = { x: Math.floor(x) + 0.5, y: Math.floor(y) + 0.5 };
        p.selfDirty = true;
    }
    cmdAttack(p, targetId) {
        if (p.deadUntil)
            return;
        if (this.mapOf(p).def.safe) {
            if (targetId.startsWith('p'))
                this.log(p, '安全區內無法攻擊玩家', 'warn');
            return;
        }
        if (targetId.startsWith('p')) {
            const o = this.byId(targetId);
            if (!o || o === p || o.mapId !== p.mapId || o.deadUntil)
                return;
            const why = this.pvpBlock(p, o);
            if (why) {
                this.log(p, why, 'warn');
                return;
            }
            p.targetId = o.id;
            p.manual = false;
            p.pickId = null;
            p.talkNpc = null;
            p.path = [];
            p.repathAt = 0;
            p.selfDirty = true;
            return;
        }
        const m = this.mapOf(p).monsters.get(targetId);
        if (!m || m.deadUntil)
            return;
        p.targetId = m.id;
        p.manual = false;
        p.pickId = null;
        p.talkNpc = null;
        p.path = [];
        p.repathAt = 0;
        p.selfDirty = true;
    }
    cmdSkill(p, skillId, targetId) {
        if (p.deadUntil)
            return;
        const sk = this.c.skills[skillId];
        if (!sk || sk.class !== p.job)
            return;
        if (!p.skills[skillId]) {
            this.log(p, `尚未學會 ${sk.name}`, 'warn');
            return;
        }
        if (sk.kind !== 'damage') {
            this.castSelf(p, skillId, true);
            return;
        }
        if (this.mapOf(p).def.safe) {
            this.log(p, '村莊內無法戰鬥', 'warn');
            return;
        }
        if (targetId)
            this.cmdAttack(p, targetId);
        if (sk.target === 'aoe_self' && !p.targetId) {
            this.castDamage(p, skillId, null, true);
            return;
        }
        p.pendingSkill = skillId;
    }
    /** PvP 條件：非安全區、雙方 Lv10+、攻擊方開啟 PK 模式（或對方為紅名）、非同隊/同誓盟 */
    pvpBlock(p, o) {
        const def = this.mapOf(p).def;
        if (def.safe)
            return '安全區內無法攻擊玩家';
        if (p.level < 10 || o.level < 10)
            return '雙方需達 Lv10 才能 PvP';
        if (p.partyId !== null && p.partyId === o.partyId)
            return '無法攻擊隊友';
        if (p.guild && o.guild && p.guild.id === o.guild.id)
            return '無法攻擊同誓盟成員';
        if (!p.pkOn && !this.isRed(o) && !def.pvp)
            return '請先開啟 PK 模式（右下角 ⚔ 按鈕）';
        return null;
    }
    cmdPk(p, on) { p.pkOn = on; p.selfDirty = true; this.log(p, on ? 'PK 模式：開啟（攻擊非紅名玩家將累積罪業）' : 'PK 模式：關閉', on ? 'warn' : 'info'); }
    cmdRecall(p) {
        if (p.deadUntil)
            return;
        const inst = this.mapOf(p);
        if (inst.def.safe) {
            this.log(p, '你已在安全區內');
            return;
        }
        if (this.now - p.lastCombat < 3000) {
            this.log(p, '戰鬥中無法回村', 'warn');
            return;
        }
        p.autoHunt = false;
        p.targetId = null;
        p.path = [];
        p.selfDirty = true;
        const t = this.c.maps[this.c.startMap];
        this.log(p, '施放回村之術，返回村莊');
        this.travel(p, t.id, t.spawn.x + 0.5, t.spawn.y + 0.5);
    }
    cmdAutoHunt(p, on) { p.autoHunt = on; p.manual = false; p.selfDirty = p.saveDirty = true; this.log(p, on ? '自動狩獵：開啟' : '自動狩獵：關閉'); }
    cmdPickup(p, id) {
        const inst = this.mapOf(p);
        if (id) {
            const l = inst.loot.get(id);
            if (l) {
                p.pickId = id;
                p.targetId = null;
                p.manual = false;
                p.path = [];
                p.repathAt = 0;
            }
            return;
        }
        let best, bd = 3;
        for (const l of inst.loot.values()) {
            const d = dist(l, p);
            if (d < bd && this.canPick(p, l)) {
                bd = d;
                best = l;
            }
        }
        if (best) {
            p.pickId = best.id;
            p.repathAt = 0;
        }
        else
            this.log(p, '附近沒有可撿取的物品');
    }
    canPick(p, l) { return this.now >= l.ownerUntil || l.owner === p.charId || (l.party !== null && l.party === p.partyId); }
    tryPick(p, l) {
        const inst = this.mapOf(p);
        if (!this.canPick(p, l)) {
            this.log(p, '這不是你的戰利品（30 秒後開放）', 'warn');
            p.pickId = null;
            return;
        }
        if (!canAdd(p.inv, this.c.items, l)) {
            this.log(p, '背包已滿，無法撿取', 'warn');
            p.ignore.set(l.id, this.now + 30000);
            p.pickId = null;
            return;
        }
        addItem(p.inv, this.c.items, l.key, l.qty, { r: l.r, aff: l.aff, enh: l.enh });
        inst.loot.delete(l.id);
        p.pickId = null;
        p.invDirty = p.saveDirty = true;
        const d = this.c.items[l.key];
        p.conn.send({ t: 'pick', key: l.key, qty: l.qty, r: l.r ?? 0, name: d.name });
        if ((l.r ?? 0) >= 3) {
            this.saveOne(p);
            this.hooks.onLoot?.(p, l.r ?? 0);
        }
    }
    cmdUsePotion(p, kind) { this.drink(p, kind, true); }
    drink(p, kind, manual) {
        if (p.deadUntil || this.now < p.potionReady)
            return false;
        const need = kind === 'hp' ? p.stats.maxHp - p.hp : p.stats.maxMp - p.mp;
        if (need <= 0)
            return false;
        const pots = p.inv.filter(i => { const d = this.c.items[i.key]; return d?.type === 'potion' && (kind === 'hp' ? d.heal : d.mana); });
        if (!pots.length) {
            if (manual)
                this.log(p, kind === 'hp' ? '沒有生命藥水了' : '沒有魔力藥水了', 'warn');
            return false;
        }
        const val = (i) => (kind === 'hp' ? this.c.items[i.key].heal : this.c.items[i.key].mana) ?? 0;
        pots.sort((a, b) => Math.abs(val(a) - need) - Math.abs(val(b) - need));
        this.consume(p, pots[0]);
        return true;
    }
    consume(p, it) {
        const d = this.c.items[it.key];
        if (--it.qty <= 0)
            p.inv.splice(p.inv.indexOf(it), 1);
        const inst = this.mapOf(p);
        if (d.heal) {
            const a = Math.min(d.heal, p.stats.maxHp - p.hp);
            p.hp += a;
            this.emit(inst, { e: 'heal', dst: p.id, amt: a }, p.x, p.y);
        }
        if (d.mana) {
            const a = Math.min(d.mana, p.stats.maxMp - p.mp);
            p.mp += a;
            this.emit(inst, { e: 'heal', dst: p.id, amt: a, mp: true }, p.x, p.y);
        }
        p.potionReady = this.now + 800;
        p.selfDirty = p.invDirty = p.saveDirty = true;
    }
    cmdUseItem(p, uid) {
        const it = p.inv.find(i => i.uid === uid);
        if (!it || p.deadUntil)
            return;
        const d = this.c.items[it.key];
        if (d.type === 'potion' && d.buff) {
            if (--it.qty <= 0)
                p.inv.splice(p.inv.indexOf(it), 1);
            const key = 'pot_' + d.buff.stat;
            p.buffs = p.buffs.filter(b => b.skill !== key);
            p.buffs.push({ stat: d.buff.stat, pct: d.buff.pct, until: this.now + d.buff.ms, skill: key });
            this.emit(this.mapOf(p), { e: 'fx', fx: 'buff', src: p.id, x: r2(p.x), y: r2(p.y), r: 1, dst: p.id }, p.x, p.y);
            this.refreshStats(p);
            this.log(p, `使用 ${d.name}`, 'good');
            return;
        }
        if (d.type === 'potion') {
            if (this.now >= p.potionReady)
                this.consume(p, it);
            return;
        }
        if (d.type === 'scroll' && d.morph) {
            const mo = this.c.morphs[d.morph];
            if (!mo)
                return;
            if (p.level < mo.level) {
                this.log(p, `需要等級 ${mo.level}`, 'warn');
                return;
            }
            if (--it.qty <= 0)
                p.inv.splice(p.inv.indexOf(it), 1);
            p.morph = d.morph;
            p.buffs = p.buffs.filter(b => b.skill !== 'morph' && b.skill !== 'morph_spd');
            p.buffs.push({ stat: 'atk', pct: mo.atk, until: this.now + mo.ms, skill: 'morph' }, { stat: 'speed', pct: mo.speed, until: this.now + mo.ms, skill: 'morph_spd' });
            this.emit(this.mapOf(p), { e: 'fx', fx: 'tp', src: p.id, x: r2(p.x), y: r2(p.y) }, p.x, p.y);
            this.refreshStats(p);
            this.log(p, `幻形為「${mo.name}」（${Math.round(mo.ms / 60000)} 分鐘）`, 'good');
            return;
        }
        if (d.type === 'scroll') {
            if (this.now - p.lastCombat < 3000) {
                this.log(p, '戰鬥中無法使用卷軸', 'warn');
                return;
            }
            const to = this.c.maps[d.tp ?? this.c.startMap];
            if (!to)
                return;
            const lv = to.level?.[0] ?? 1;
            if (p.level < Math.max(1, lv - 5)) {
                this.log(p, `需要等級 ${Math.max(1, lv - 5)}`, 'warn');
                return;
            }
            if (--it.qty <= 0)
                p.inv.splice(p.inv.indexOf(it), 1);
            p.invDirty = true;
            this.travel(p, to.id, to.spawn.x + 0.5, to.spawn.y + 0.5);
            return;
        }
        if (d.type === 'pet' && d.pet) {
            if (p.pet === d.pet) {
                p.pet = null;
                delete p.counters.pet;
                this.log(p, '收回靈寵');
            }
            else {
                p.pet = d.pet;
                p.counters.pet = 1;
                p.counters.petKey = d.pet;
                this.log(p, `召喚靈寵「${this.c.pets[d.pet].name}」`, 'good');
            }
            p.selfDirty = p.progDirty = p.saveDirty = true;
            return;
        }
        if (isGear(d))
            this.cmdEquip(p, uid);
    }
    cmdEquip(p, uid) {
        if (p.tradeId !== null) {
            this.log(p, '交易中無法更換裝備', 'warn');
            return;
        }
        const idx = p.inv.findIndex(i => i.uid === uid);
        if (idx < 0)
            return;
        const it = p.inv[idx], d = this.c.items[it.key];
        if (!isGear(d))
            return;
        if (d.class && d.class !== p.job) {
            this.log(p, `${d.name} 不是你的職業可用的裝備`, 'warn');
            return;
        }
        if ((d.req ?? 1) > p.level) {
            this.log(p, `需要等級 ${d.req}`, 'warn');
            return;
        }
        const slot = d.type, prev = p.eq[slot];
        p.inv.splice(idx, 1);
        if (prev)
            p.inv.splice(idx, 0, prev);
        p.eq[slot] = it;
        this.refreshStats(p);
        this.log(p, `已裝備 ${d.name}`);
    }
    cmdUnequip(p, slot) {
        const it = p.eq[slot];
        if (!it || p.tradeId !== null)
            return;
        if (p.inv.length >= 48) {
            this.log(p, '背包已滿', 'warn');
            return;
        }
        delete p.eq[slot];
        p.inv.push(it);
        this.refreshStats(p);
    }
    refreshStats(p) {
        p.stats = this.statsOf(p);
        p.hp = Math.min(p.hp, p.stats.maxHp);
        p.mp = Math.min(p.mp, p.stats.maxMp);
        p.selfDirty = p.invDirty = p.saveDirty = true;
    }
    cmdLearn(p, skillId) {
        const sk = this.c.skills[skillId];
        if (!sk || sk.class !== p.job)
            return;
        const cur = p.skills[skillId] ?? 0;
        if (p.level < sk.level) {
            this.log(p, `需要等級 ${sk.level}`, 'warn');
            return;
        }
        if ((sk.adv ?? 0) > this.advStage(p)) {
            this.log(p, sk.adv === 1 ? '需要先完成轉職' : '需要先完成覺醒', 'warn');
            return;
        }
        if (cur >= sk.maxRank) {
            this.log(p, '已達最高等級', 'warn');
            return;
        }
        if (this.skillPoints(p) <= 0) {
            this.log(p, '技能點不足', 'warn');
            return;
        }
        p.skills[skillId] = cur + 1;
        p.progDirty = p.saveDirty = true;
        this.log(p, `${sk.name} 提升至 Lv.${cur + 1}`, 'good');
    }
    cmdTalk(p, npcId) {
        const n = this.mapOf(p).def.npcs.find(n => n.id === npcId || n.npc === npcId);
        if (!n || p.deadUntil)
            return;
        npcId = n.id;
        p.talkNpc = npcId;
        p.targetId = null;
        p.pickId = null;
        p.manual = false;
        p.repathAt = 0;
        p.path = [];
    }
    nearNpc(p, pred, range = 4) {
        return this.mapOf(p).def.npcs.find(n => pred(n.npc) && Math.hypot(n.x + 0.5 - p.x, n.y + 0.5 - p.y) <= range);
    }
    onTalk = () => { };
    // ---------------- tick ----------------
    tick(now) {
        const dt = Math.min(0.5, (now - this.now) / 1000);
        this.now = now;
        for (const inst of this.maps.values()) {
            for (const m of [...inst.monsters.values()])
                this.updateMonster(inst, m, dt);
            for (const p of [...inst.players])
                this.updatePlayer(inst, p, dt);
            for (const l of inst.loot.values())
                if (now > l.expire)
                    inst.loot.delete(l.id);
        }
        this.broadcast();
        if (now - this.lastSave > 5000) {
            this.lastSave = now;
            this.saveDirty();
        }
    }
    step(e, speed, dt) {
        let budget = speed * dt;
        const moving0 = e.path.length > 0;
        while (budget > 0 && e.path.length) {
            const [tx, ty] = e.path[0], last = e.path.length === 1 && e.dest;
            const gx = last ? e.dest.x : tx + 0.5, gy = last ? e.dest.y : ty + 0.5;
            const dx = gx - e.x, dy = gy - e.y, d = Math.hypot(dx, dy);
            if (d > 1e-3)
                e.dir = dirOf(dx, dy);
            if (d <= budget) {
                e.x = gx;
                e.y = gy;
                budget -= d;
                e.path.shift();
            }
            else {
                e.x += (dx / d) * budget;
                e.y += (dy / d) * budget;
                budget = 0;
            }
        }
        if (e.path.length) {
            if (e.act !== 'attack' && e.act !== 'cast')
                e.act = 'walk';
        }
        else if (moving0 || e.act === 'walk')
            e.act = 'idle';
    }
    face(e, t) { if (dist(e, t) > 0.01)
        e.dir = dirOf(t.x - e.x, t.y - e.y); }
    findP(inst, id) { if (!id)
        return undefined; for (const p of inst.players)
        if (p.id === id)
            return p; return undefined; }
    updateMonster(inst, m, dt) {
        const d = this.c.monsters[m.key];
        if (m.deadUntil) {
            if (this.now >= m.deadUntil) {
                inst.monsters.delete(m.id);
                this.spawnMonster(inst, m.key, m.area);
            }
            return;
        }
        // 持續傷害
        for (const dot of m.dots)
            if (this.now >= dot.next) {
                dot.next += 1000;
                dot.left--;
                const src = this.findP(inst, dot.src);
                m.hp = Math.max(0, m.hp - dot.dmg);
                this.emit(inst, { e: 'dmg', src: dot.src, dst: m.id, amt: dot.dmg, crit: false, skill: 'poison' }, m.x, m.y);
                if (m.hp <= 0) {
                    this.killMonster(inst, src, m);
                    return;
                }
            }
        m.dots = m.dots.filter(x => x.left > 0);
        if ((m.act === 'attack' || m.act === 'hit') && this.now > m.actUntil)
            m.act = 'idle';
        let t = this.findP(inst, m.targetId);
        const leash = d.rank ? 16 : 12;
        if (t && (t.deadUntil || t.mapId !== m.mapId || Math.hypot(m.x - m.homeX, m.y - m.homeY) > leash)) {
            t = undefined;
            m.targetId = null;
            m.path = findPath(inst.grid, m.x, m.y, m.homeX, m.homeY, 2000) ?? [];
            m.dest = null;
            m.hp = m.maxHp;
            m.dmgBy.clear();
        }
        if (!t && d.aggro > 0)
            for (const p of inst.players)
                if (!p.deadUntil && dist(p, m) <= d.aggro) {
                    t = p;
                    m.targetId = p.id;
                    break;
                }
        if (t) {
            const dd = dist(t, m), reach = d.range + (d.size ?? 1) * 0.3;
            if (dd <= reach) {
                m.path = [];
                this.face(m, t);
                if (m.act === 'walk')
                    m.act = 'idle';
                if (this.now >= m.atkReady) {
                    m.atkReady = this.now + d.attackMs;
                    m.act = 'attack';
                    m.actUntil = this.now + 600;
                    m.aseq++;
                    if (d.projectile)
                        this.emit(inst, { e: 'fx', fx: 'm_' + d.projectile, src: m.id, x: r2(m.x), y: r2(m.y), tx: r2(t.x), ty: r2(t.y), dst: t.id }, m.x, m.y);
                    const r = computeDamage(d.atk, t.stats.def, 1, this.rng, d.rank ? 0.1 : 0.05);
                    this.hurtPlayer(inst, t, r.amount, r.crit, m.id);
                }
            }
            else if (this.now >= m.repathAt) {
                m.repathAt = this.now + 500;
                m.path = findPath(inst.grid, m.x, m.y, t.x, t.y, 1500) ?? [];
                m.dest = null;
                if (m.path.length)
                    m.path.pop();
            }
        }
        else if (!m.path.length && this.now >= m.wanderAt) {
            m.wanderAt = this.now + 3000 + this.rng() * 5000;
            const tx = m.homeX + (this.rng() - 0.5) * 7, ty = m.homeY + (this.rng() - 0.5) * 7;
            if (inst.grid.ok(Math.floor(tx), Math.floor(ty))) {
                m.path = findPath(inst.grid, m.x, m.y, tx, ty, 300) ?? [];
                m.dest = null;
            }
        }
        const slow = this.now < m.slowUntil ? 0.5 : 1;
        this.step(m, (t ? d.speed * 1.25 : d.speed * 0.55) * slow, dt);
    }
    hurtPlayer(inst, p, amt, crit, src) {
        if (p.deadUntil)
            return;
        p.hp = Math.max(0, p.hp - amt);
        p.lastCombat = this.now;
        p.selfDirty = p.saveDirty = true;
        this.emit(inst, { e: 'dmg', src, dst: p.id, amt, crit }, p.x, p.y);
        if (p.hp <= 0) {
            this.killPlayer(inst, p, src.startsWith('p') ? this.byId(src) : undefined);
            return;
        }
        if (p.act === 'idle') {
            p.act = 'hit';
            p.actUntil = this.now + 250;
        }
        if (p.autoHunt && p.hp < p.stats.maxHp * (p.settings.autoPotionPct / 100))
            this.drink(p, 'hp', false);
        if (!p.targetId && !p.manual && !p.pickId && !p.talkNpc && !inst.def.safe && !src.startsWith('p'))
            p.targetId = src;
    }
    killPlayer(inst, p, killer) {
        const red = this.isRed(p);
        const lost = deathPenalty(p);
        if (p.morph) {
            p.morph = null;
        }
        this.hooks.onPlayerKilled?.(p, killer);
        p.deadUntil = this.now + 5000;
        p.act = 'dead';
        p.path = [];
        p.targetId = null;
        p.pendingSkill = null;
        p.pickId = null;
        p.buffs = [];
        this.emit(inst, { e: 'die', id: p.id }, p.x, p.y);
        this.log(p, `你倒下了…損失 ${lost} 經驗，5 秒後復活${killer ? `（擊倒者：${killer.name}）` : ''}`, 'warn');
        // 死亡掉落：有機率掉出背包中一件未強化的物品（30 秒內僅本人可撿回）
        // 紅名死亡：掉落率提高，且可能掉出已強化/穿戴中的裝備
        const pool = red ? [...p.inv, ...Object.values(p.eq).filter(Boolean)] : p.inv.filter(it => !it.enh);
        if (pool.length && this.rng() < (red ? 0.6 : 0.25)) {
            const it = pool[Math.floor(this.rng() * pool.length)], q = Math.max(1, Math.min(it.qty, Math.ceil(it.qty * 0.3)));
            const slot = Object.keys(p.eq).find(s => p.eq[s] === it);
            if (slot) {
                delete p.eq[slot];
                p.stats = this.statsOf(p);
            }
            else if (q >= it.qty)
                p.inv.splice(p.inv.indexOf(it), 1);
            else
                it.qty -= q;
            const id = 'l' + ++this.seq;
            inst.loot.set(id, { id, key: it.key, qty: q, r: it.r, aff: it.aff, enh: it.enh, x: p.x, y: p.y, owner: p.charId, party: null, ownerUntil: this.now + 120000, expire: this.now + 180000 });
            this.log(p, `死亡時掉落了 ${this.c.items[it.key]?.name ?? it.key}${q > 1 ? ' ×' + q : ''}（可回原地撿回）`, 'bad');
            p.invDirty = p.saveDirty = true;
        }
        p.conn.send({ t: 'dead', lostExp: lost, ms: 5000 });
        for (const m of inst.monsters.values())
            if (m.targetId === p.id)
                m.targetId = null;
        this.markAll(p);
    }
    respawn(p) {
        if (!p.deadUntil || this.now < p.deadUntil)
            return;
        p.deadUntil = 0;
        p.hp = p.stats.maxHp;
        p.mp = p.stats.maxMp;
        p.act = 'idle';
        const t = this.c.maps[this.c.startMap];
        this.travel(p, t.id, t.spawn.x + 0.5, t.spawn.y + 0.5);
        p.selfDirty = true;
    }
    updatePlayer(inst, p, dt) {
        if (p.deadUntil) {
            if (this.now >= p.deadUntil + 100)
                this.respawn(p);
            return;
        }
        if ((p.act === 'attack' || p.act === 'cast' || p.act === 'hit') && this.now > p.actUntil)
            p.act = p.path.length ? 'walk' : 'idle';
        if (p.buffs.length && p.buffs.some(b => b.until <= this.now)) {
            p.buffs = p.buffs.filter(b => b.until > this.now);
            if (p.morph && !p.buffs.some(b => b.skill === 'morph')) {
                p.morph = null;
                this.log(p, '幻形效果結束');
            }
            this.refreshStats(p);
        }
        p.regenAcc += dt;
        if (p.regenAcc >= 1) {
            p.regenAcc -= 1;
            const ooc = this.now - p.lastCombat > 4000, safe = inst.def.safe;
            const mp = Math.min(p.stats.maxMp, p.mp + 1 + Math.round(p.stats.maxMp * (safe ? 0.08 : 0.025)));
            const hp = ooc || safe ? Math.min(p.stats.maxHp, p.hp + Math.max(1, Math.round(p.stats.maxHp * (safe ? 0.08 : 0.025)))) : p.hp;
            if (mp !== p.mp || hp !== p.hp) {
                p.mp = mp;
                p.hp = hp;
                p.selfDirty = true;
            }
        }
        if (p.autoHunt) {
            if (p.hp < p.stats.maxHp * (p.settings.autoPotionPct / 100))
                this.drink(p, 'hp', false);
            if (p.mp < p.stats.maxMp * 0.25)
                this.drink(p, 'mp', false);
            if (p.settings.autoSkills && !inst.def.safe)
                for (const s of this.c.classes[p.job].skills) {
                    const sk = this.c.skills[s];
                    if (!p.skills[s] || sk.kind === 'damage')
                        continue;
                    if (sk.kind === 'heal' && p.hp < p.stats.maxHp * 0.55)
                        this.castSelf(p, s, false);
                    if (sk.kind === 'buff' && p.targetId && !p.buffs.some(b => b.skill === s))
                        this.castSelf(p, s, false);
                }
        }
        // 對話 NPC
        if (p.talkNpc) {
            const n = inst.def.npcs.find(n => n.id === p.talkNpc);
            if (!n)
                p.talkNpc = null;
            else if (Math.hypot(n.x + 0.5 - p.x, n.y + 0.5 - p.y) <= 2.2) {
                p.path = [];
                this.face(p, { x: n.x + 0.5, y: n.y + 0.5 });
                p.talkNpc = null;
                this.onTalk(p, n.npc);
            }
            else if (this.now >= p.repathAt) {
                p.repathAt = this.now + 600;
                let path = null;
                const ring = [];
                for (let r = 1; r <= 2 && !ring.length; r++)
                    for (let dy = -r; dy <= r; dy++)
                        for (let dx = -r; dx <= r; dx++)
                            if (Math.max(Math.abs(dx), Math.abs(dy)) === r && inst.grid.ok(n.x + dx, n.y + dy))
                                ring.push([n.x + dx, n.y + dy]);
                ring.sort((a, b) => Math.hypot(a[0] + 0.5 - p.x, a[1] + 0.5 - p.y) - Math.hypot(b[0] + 0.5 - p.x, b[1] + 0.5 - p.y));
                for (const [tx, ty] of ring.slice(0, 4)) {
                    path = findPath(inst.grid, p.x, p.y, tx + 0.5, ty + 0.5, 6000);
                    if (path)
                        break;
                }
                if (path) {
                    p.path = path;
                    p.dest = null;
                }
                else
                    p.talkNpc = null;
            }
        }
        // 撿取
        if (p.pickId) {
            const l = inst.loot.get(p.pickId);
            if (!l)
                p.pickId = null;
            else if (dist(l, p) <= 1.2) {
                p.path = [];
                this.tryPick(p, l);
            }
            else if (this.now >= p.repathAt) {
                p.repathAt = this.now + 500;
                const path = findPath(inst.grid, p.x, p.y, l.x, l.y, 3000);
                if (path) {
                    p.path = path;
                    p.dest = { x: l.x, y: l.y };
                }
                else
                    p.pickId = null;
            }
        }
        if (p.targetId?.startsWith('p')) {
            this.updatePvp(inst, p);
        }
        let target = p.targetId && !p.targetId.startsWith('p') ? inst.monsters.get(p.targetId) : undefined;
        if (target && target.deadUntil) {
            target = undefined;
            p.targetId = null;
            p.selfDirty = true;
        }
        if (!target && !p.pickId && !p.talkNpc && p.autoHunt && !p.manual && !inst.def.safe && !p.targetId?.startsWith('p')) {
            if (p.settings.autoPickup) {
                let best, bd = 6;
                for (const l of inst.loot.values()) {
                    const d = dist(l, p);
                    const ig = p.ignore.get(l.id);
                    if (d < bd && (l.owner === p.charId || (l.party !== null && l.party === p.partyId)) && !(ig && ig > this.now) && canAdd(p.inv, this.c.items, l)) {
                        bd = d;
                        best = l;
                    }
                }
                if (best) {
                    p.pickId = best.id;
                    p.repathAt = 0;
                }
            }
            if (!p.pickId) {
                target = this.findHuntTarget(inst, p);
                if (target) {
                    p.targetId = target.id;
                    p.repathAt = 0;
                    p.selfDirty = true;
                }
            }
        }
        if (p.autoHunt && !p.manual && !p.talkNpc && inst.def.safe && !p.path.length && this.now >= p.repathAt && inst.def.portals.length) {
            // 安全區內開啟自動狩獵：自動走向最近的出口傳送陣
            p.repathAt = this.now + 1500;
            const pt = [...inst.def.portals].sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))[0];
            const path = findPath(inst.grid, p.x, p.y, pt.x + pt.w / 2, pt.y + pt.h / 2, 8000);
            if (path) {
                p.path = path;
                p.dest = { x: pt.x + pt.w / 2, y: pt.y + pt.h / 2 };
                if (!p.autoLeaveMsg) {
                    p.autoLeaveMsg = true;
                    this.log(p, `自動前往狩獵區：${pt.label ?? pt.to}`);
                }
            }
        }
        if (target && !p.pickId) {
            const pend = p.pendingSkill ? this.c.skills[p.pendingSkill] : null;
            const range = pend ? Math.max(pend.range, p.stats.range) : p.stats.range;
            const dd = dist(p, target);
            if (dd <= range + 0.2) {
                p.path = [];
                this.face(p, target);
                if (p.act === 'walk')
                    p.act = 'idle';
                if (this.now >= p.atkReady) {
                    let skill = p.pendingSkill;
                    if (!skill && p.autoHunt && p.settings.autoSkills) {
                        const avail = this.c.classes[p.job].skills.filter(s => { const sk = this.c.skills[s]; return p.skills[s] && sk.kind === 'damage' && p.mp >= sk.mp && this.now >= (p.skillReady[s] ?? 0) && dd <= sk.range + 0.2; });
                        skill = avail.sort((a, b) => (this.c.skills[b].mult ?? 0) - (this.c.skills[a].mult ?? 0))[0] ?? null;
                    }
                    if (skill) {
                        if (!this.castDamage(p, skill, target, !!p.pendingSkill))
                            this.basicAttack(inst, p, target);
                        p.pendingSkill = null;
                    }
                    else
                        this.basicAttack(inst, p, target);
                }
            }
            else if (this.now >= p.repathAt) {
                p.repathAt = this.now + 400;
                const path = findPath(inst.grid, p.x, p.y, target.x, target.y, 3000);
                if (!path) {
                    p.ignore.set(target.id, this.now + 15000);
                    p.targetId = null;
                }
                else {
                    if (path.length)
                        path.pop();
                    p.path = path;
                    p.dest = null;
                    if (!path.length) {
                        p.path = [[Math.floor(target.x), Math.floor(target.y)]];
                        p.dest = { x: target.x, y: target.y };
                    }
                }
            }
        }
        // 自動狩獵卡住：10 秒未戰鬥，免費瞬移到怪物附近
        if (!p.autoHunt || p.manual || inst.def.safe || p.talkNpc || p.unstuckAt === undefined)
            p.unstuckAt = this.now;
        else if (this.now - Math.max(p.unstuckAt, p.lastCombat) > UNSTUCK_MS) {
            p.unstuckAt = this.now;
            const alive = [...inst.monsters.values()].filter(m => !m.deadUntil && !(p.ignore.get(m.id) > this.now));
            const m = alive[Math.floor(this.rng() * alive.length)];
            if (m) {
                const spots = [];
                for (let dy = -2; dy <= 2; dy++)
                    for (let dx = -2; dx <= 2; dx++)
                        if ((dx || dy) && inst.grid.ok(Math.floor(m.x) + dx, Math.floor(m.y) + dy))
                            spots.push([Math.floor(m.x) + dx, Math.floor(m.y) + dy]);
                const sp = spots[Math.floor(this.rng() * spots.length)];
                if (sp) {
                    p.x = sp[0] + 0.5;
                    p.y = sp[1] + 0.5;
                    p.path = [];
                    p.dest = null;
                    p.targetId = m.id;
                    p.repathAt = 0;
                    p.selfDirty = true;
                    this.emit(inst, { e: 'fx', fx: 'tp', src: p.id, x: r2(p.x), y: r2(p.y) }, p.x, p.y);
                    this.log(p, `${UNSTUCK_MS / 1000}秒未攻擊自動瞬移（免費脫困）`);
                }
            }
        }
        const before = { x: p.x, y: p.y };
        this.step(p, p.stats.speed, dt);
        if (p.manual && !p.path.length)
            p.manual = false;
        if (before.x !== p.x || before.y !== p.y) {
            // 經過時自動撿起自己的東西
            for (const l of inst.loot.values())
                if (dist(l, p) < 0.6 && l.owner === p.charId && canAdd(p.inv, this.c.items, l) && p.settings.autoPickup) {
                    this.tryPick(p, l);
                    break;
                }
            const tx = Math.floor(p.x), ty = Math.floor(p.y);
            for (const pt of inst.def.portals)
                if (tx >= pt.x && tx < pt.x + pt.w && ty >= pt.y && ty < pt.y + pt.h) {
                    this.travel(p, pt.to, pt.tx + 0.5, pt.ty + 0.5);
                    return;
                }
        }
    }
    updatePvp(inst, p) {
        const o = this.byId(p.targetId);
        if (!o || o.mapId !== p.mapId || o.deadUntil || this.pvpBlock(p, o)) {
            p.targetId = null;
            p.selfDirty = true;
            return;
        }
        const dd = dist(p, o);
        if (dd <= p.stats.range + 0.2) {
            p.path = [];
            this.face(p, o);
            if (p.act === 'walk')
                p.act = 'idle';
            if (this.now >= p.atkReady) {
                const cls = this.c.classes[p.job];
                p.atkReady = this.now + p.stats.attackMs;
                p.act = cls.cast ? 'cast' : 'attack';
                p.actUntil = this.now + 500;
                p.aseq++;
                p.lastCombat = o.lastCombat = this.now;
                if (cls.projectile)
                    this.emit(inst, { e: 'fx', fx: cls.projectile === 'arrow' ? 'arrow_basic' : 'magic_basic', src: p.id, x: r2(p.x), y: r2(p.y), tx: r2(o.x), ty: r2(o.y), dst: o.id }, p.x, p.y);
                // 先手攻擊非紅名者：標記為攻擊者（60 秒內對方反擊無罪）
                if (!this.isRed(o) && this.now >= o.aggrUntil && !inst.def.pvp)
                    p.aggrUntil = this.now + 60000;
                const r = computeDamage(p.stats.atk, o.stats.def, 0.6, this.rng, p.stats.crit);
                this.hurtPlayer(inst, o, r.amount, r.crit, p.id);
            }
        }
        else if (this.now >= p.repathAt) {
            p.repathAt = this.now + 400;
            const path = findPath(inst.grid, p.x, p.y, o.x, o.y, 3000);
            if (path) {
                if (path.length)
                    path.pop();
                p.path = path;
                p.dest = null;
            }
        }
    }
    basicAttack(inst, p, target) {
        const cls = this.c.classes[p.job];
        p.atkReady = this.now + p.stats.attackMs;
        p.act = 'attack';
        p.actUntil = this.now + 500;
        p.aseq++;
        if (cls.projectile)
            this.emit(inst, { e: 'fx', fx: cls.projectile === 'arrow' ? 'arrow_basic' : 'magic_basic', src: p.id, x: r2(p.x), y: r2(p.y), tx: r2(target.x), ty: r2(target.y), dst: target.id }, p.x, p.y);
        this.hitMonster(inst, p, target, 1);
        const pet = p.pet ? this.c.pets[p.pet] : undefined;
        if (pet && !target.deadUntil)
            this.hitMonster(inst, p, target, pet.dmg, 'pet');
    }
    /** 傷害技能；回傳是否施放 */
    castDamage(p, skill, target, manual) {
        const inst = this.mapOf(p), sk = this.c.skills[skill], rank = p.skills[skill] ?? 0;
        if (!rank || p.mp < sk.mp || this.now < (p.skillReady[skill] ?? 0)) {
            if (manual)
                this.log(p, `${sk.name} 尚未就緒或 MP 不足`, 'warn');
            return false;
        }
        p.mp -= sk.mp;
        p.skillReady[skill] = this.now + sk.cooldownMs;
        p.atkReady = this.now + p.stats.attackMs;
        p.act = this.c.classes[p.job].cast ? 'cast' : 'attack';
        p.actUntil = this.now + 550;
        p.aseq++;
        p.selfDirty = true;
        p.lastCombat = this.now;
        const center = sk.target === 'aoe_self' || !target ? p : target;
        this.emit(inst, { e: 'fx', fx: sk.fx, src: p.id, x: r2(p.x), y: r2(p.y), tx: r2(center.x), ty: r2(center.y), r: sk.aoe ?? 0, dst: target?.id }, center.x, center.y);
        const mult = skillMult(sk, rank);
        const hits = sk.aoe ? [...inst.monsters.values()].filter(m => !m.deadUntil && dist(m, center) <= sk.aoe).slice(0, 12) : target ? [target] : [];
        for (const m of hits) {
            if (sk.slow)
                m.slowUntil = this.now + 3000;
            if (sk.dot)
                m.dots.push({ next: this.now + 1000, left: sk.dot.ticks, dmg: Math.max(1, Math.round(p.stats.atk * sk.dot.mult * (1 + 0.1 * (rank - 1)))), src: p.id });
            this.hitMonster(inst, p, m, mult, skill, !!sk.sure);
            if (sk.drain) {
                const a = Math.min(p.stats.maxHp - p.hp, Math.round(p.stats.atk * mult * sk.drain * 0.5));
                if (a > 0) {
                    p.hp += a;
                    this.emit(inst, { e: 'heal', dst: p.id, amt: a }, p.x, p.y);
                }
            }
        }
        return true;
    }
    /** 自身型技能（治療/增益） */
    castSelf(p, skill, manual) {
        const inst = this.mapOf(p), sk = this.c.skills[skill], rank = p.skills[skill] ?? 0;
        if (!rank || p.deadUntil)
            return;
        if (p.mp < sk.mp || this.now < (p.skillReady[skill] ?? 0)) {
            if (manual)
                this.log(p, `${sk.name} 尚未就緒或 MP 不足`, 'warn');
            return;
        }
        p.mp -= sk.mp;
        p.skillReady[skill] = this.now + sk.cooldownMs;
        p.act = 'cast';
        p.actUntil = this.now + 550;
        p.aseq++;
        p.selfDirty = true;
        this.emit(inst, { e: 'fx', fx: sk.fx, src: p.id, x: r2(p.x), y: r2(p.y), r: sk.aoe ?? 1, dst: p.id }, p.x, p.y);
        if (sk.healPct) {
            const pct = sk.healPct + (sk.kind === 'heal' ? (sk.perRank ?? 0) * (rank - 1) : 0);
            const targets = sk.kind === 'heal' && sk.aoe ? [...inst.players].filter(o => !o.deadUntil && (o === p || (p.partyId !== null && o.partyId === p.partyId)) && dist(o, p) <= sk.aoe) : [p];
            for (const o of targets) {
                const a = Math.min(o.stats.maxHp - o.hp, Math.round(o.stats.maxHp * pct));
                o.hp += a;
                o.selfDirty = true;
                this.emit(inst, { e: 'heal', dst: o.id, amt: a }, o.x, o.y);
            }
        }
        if (sk.buff) {
            p.buffs = p.buffs.filter(b => b.skill !== skill);
            p.buffs.push({ stat: sk.buff.stat, pct: skillBuffPct(sk, rank), until: this.now + sk.buff.ms, skill });
            this.refreshStats(p);
        }
    }
    findHuntTarget(inst, p) {
        let best, bd = 26;
        for (const m of inst.monsters.values()) {
            if (m.deadUntil)
                continue;
            const ig = p.ignore.get(m.id);
            if (ig && ig > this.now)
                continue;
            const d = dist(m, p) + (m.targetId && m.targetId !== p.id ? 8 : 0);
            if (d < bd) {
                bd = d;
                best = m;
            }
        }
        return best;
    }
    hitMonster(inst, p, m, mult, skill, forceCrit = false) {
        const d = this.c.monsters[m.key];
        const r = computeDamage(p.stats.atk, d.def, mult, this.rng, p.stats.crit, forceCrit);
        m.hp = Math.max(0, m.hp - r.amount);
        p.lastCombat = this.now;
        m.dmgBy.set(p.id, (m.dmgBy.get(p.id) ?? 0) + r.amount);
        if (!m.targetId)
            m.targetId = p.id;
        if (m.act === 'idle' || m.act === 'walk') {
            m.act = 'hit';
            m.actUntil = this.now + 220;
        }
        this.emit(inst, { e: 'dmg', src: p.id, dst: m.id, amt: r.amount, crit: r.crit, skill }, m.x, m.y);
        if (m.hp <= 0)
            this.killMonster(inst, p, m);
    }
    killMonster(inst, killer, m) {
        const d = this.c.monsters[m.key];
        m.deadUntil = this.now + (d.respawnSec ?? 9) * 1000;
        m.goneAt = this.now + 1600;
        m.act = 'dead';
        m.path = [];
        m.dots = [];
        m.targetId = null;
        this.emit(inst, { e: 'die', id: m.id }, m.x, m.y);
        if (d.rank) {
            this.bossTimers.set(m.key, { monster: m.key, map: inst.def.id, alive: false, at: m.deadUntil });
            this.broadcastBossTimers();
        }
        // 最高傷害者為擁有者
        let owner = killer;
        let top = 0;
        for (const [id, dmg] of m.dmgBy) {
            const pl = this.findP(inst, id);
            if (pl && dmg > top) {
                top = dmg;
                owner = pl;
            }
        }
        if (!owner)
            return;
        for (const pl of inst.players)
            if (pl.targetId === m.id)
                pl.targetId = null;
        // 經驗（隊伍分享）
        const mates = owner.partyId === null ? [owner] : [...inst.players].filter(o => o.partyId === owner.partyId && !o.deadUntil && dist(o, m) <= 20);
        const share = partyShare(d.exp, mates.length);
        for (const pl of mates) {
            this.gainExp(pl, share);
            pl.counters.kills = (pl.counters.kills ?? 0) + 1;
            if (d.rank)
                pl.counters.bosses = (pl.counters.bosses ?? 0) + 1;
            this.hooks.onKill?.(pl, m.key);
            pl.conn.send({ t: 'kill', monster: d.name, exp: share });
        }
        const gold = rollGold(d.gold, this.rng);
        owner.gold += gold;
        owner.selfDirty = owner.saveDirty = true;
        this.emit(inst, { e: 'loot', id: m.id, r: -1 }, m.x, m.y);
        owner.conn.send({ t: 'gold', amt: gold, from: d.name, x: r2(m.x), y: r2(m.y) });
        const loot = rollDrops(this.c.drops[d.drops], this.rng);
        loot.forEach((l0, i) => {
            const l = finalizeLoot(l0, this.c.items, this.rng, d.rank === 'boss' ? 0.5 : d.rank ? 0.3 : 0);
            const a = (i / Math.max(1, loot.length)) * Math.PI * 2 + this.rng(), rr = loot.length > 1 ? 0.6 + this.rng() * 0.5 : 0;
            let x = m.x + Math.cos(a) * rr, y = m.y + Math.sin(a) * rr;
            if (!inst.grid.ok(Math.floor(x), Math.floor(y))) {
                x = m.x;
                y = m.y;
            }
            const id = 'l' + ++this.seq;
            inst.loot.set(id, { id, key: l.key, qty: l.qty, r: l.r, aff: l.aff, x, y, owner: owner.charId, party: owner.partyId, ownerUntil: this.now + 30000, expire: this.now + 90000 });
            if ((l.r ?? 0) >= 2)
                this.emit(inst, { e: 'loot', id, r: l.r }, x, y);
        });
    }
    gainExp(p, amt) {
        const ups = applyExp(p, amt);
        p.selfDirty = p.saveDirty = true;
        if (ups) {
            p.stats = this.statsOf(p);
            p.hp = p.stats.maxHp;
            p.mp = p.stats.maxMp;
            this.emit(this.mapOf(p), { e: 'lvl', id: p.id, lv: p.level }, p.x, p.y);
            this.log(p, `升級了！目前等級 ${p.level}（獲得技能點）`, 'good');
            p.progDirty = true;
            this.hooks.onLevel?.(p);
            this.saveOne(p);
        }
    }
    travel(p, to, tx, ty) {
        const from = this.mapOf(p), dest = this.maps.get(to);
        if (!dest)
            return;
        from.players.delete(p);
        for (const m of from.monsters.values())
            if (m.targetId === p.id)
                m.targetId = null;
        const pos = dest.grid.ok(Math.floor(tx), Math.floor(ty)) ? { x: tx, y: ty } : this.nearestWalkable(dest, tx, ty);
        p.mapId = to;
        p.x = pos.x;
        p.y = pos.y;
        p.path = [];
        p.targetId = null;
        p.pickId = null;
        p.talkNpc = null;
        p.manual = false;
        p.ignore.clear();
        p.selfDirty = p.saveDirty = true;
        dest.players.add(p);
        this.sendMap(p);
        this.log(p, `進入 ${dest.def.name}`);
    }
    // ---------------- AOI 增量廣播 ----------------
    broadcast() {
        for (const inst of this.maps.values()) {
            if (!inst.players.size) {
                inst.events = [];
                continue;
            }
            // 空間格
            const grid = new Map();
            const W = Math.ceil(inst.def.width / CELL);
            const add = (id, x, y, v) => { const k = Math.floor(y / CELL) * W + Math.floor(x / CELL); let a = grid.get(k); if (!a)
                grid.set(k, a = []); a.push({ id, x, y, v }); };
            for (const p of inst.players)
                add(p.id, p.x, p.y, () => this.viewP(p));
            for (const m of inst.monsters.values())
                if (!m.deadUntil || this.now < m.goneAt)
                    add(m.id, m.x, m.y, () => this.viewM(m));
            for (const l of inst.loot.values())
                add(l.id, l.x, l.y, () => this.viewL(l));
            const cache = new Map();
            for (const p of inst.players) {
                const up = [], rm = [], seen = new Set();
                const cx = Math.floor(p.x / CELL), cy = Math.floor(p.y / CELL), cr = Math.ceil(AOI_RADIUS / CELL);
                for (let gy = cy - cr; gy <= cy + cr; gy++)
                    for (let gx = cx - cr; gx <= cx + cr; gx++) {
                        if (gx < 0 || gy < 0 || gx >= W)
                            continue;
                        for (const e of grid.get(gy * W + gx) ?? []) {
                            if (Math.abs(e.x - p.x) > AOI_RADIUS || Math.abs(e.y - p.y) > AOI_RADIUS)
                                continue;
                            seen.add(e.id);
                            let s = cache.get(e.id);
                            let v;
                            if (s === undefined) {
                                v = e.v();
                                s = JSON.stringify(v);
                                cache.set(e.id, s);
                            }
                            if (p.known.get(e.id) !== s) {
                                p.known.set(e.id, s);
                                up.push(v ?? JSON.parse(s));
                            }
                        }
                    }
                for (const id of p.known.keys())
                    if (!seen.has(id)) {
                        rm.push(id);
                        p.known.delete(id);
                    }
                const ev = inst.events.filter(e => Math.abs(e.x - p.x) <= AOI_RADIUS + 4 && Math.abs(e.y - p.y) <= AOI_RADIUS + 4).map(e => e.ev);
                if (up.length || rm.length || ev.length)
                    p.conn.send({ t: 'd', up, rm, ev });
                this.flushSelf(p);
            }
            inst.events = [];
        }
    }
    // ---------------- 存檔 ----------------
    saveOne(p) {
        const tx = this.db.transaction(() => {
            this.db.prepare(`UPDATE characters SET level=?, exp=?, hp=?, mp=?, gold=?, map=?, x=?, y=?, auto_hunt=?, skills=?, quests=?, settings=?, daily=?, achievements=?, stats=?, last_seen=? WHERE id=?`)
                .run(p.level, p.exp, Math.max(1, p.hp), p.mp, p.gold, p.mapId, p.x, p.y, p.autoHunt ? 1 : 0, JSON.stringify(p.skills), JSON.stringify(p.quests), JSON.stringify(p.settings), JSON.stringify(p.daily), JSON.stringify(p.ach), JSON.stringify(p.counters), Date.now(), p.charId);
            saveItems(this.db, p.charId, p.inv, p.eq);
        });
        tx();
        p.saveDirty = false;
    }
    /** 只存有變動的角色；沒變動的也更新 last_seen（離線結算用） */
    saveDirty() {
        const touch = this.db.prepare('UPDATE characters SET last_seen=?, x=?, y=?, map=? WHERE id=?');
        this.db.transaction(() => { for (const p of this.players.values()) {
            if (p.saveDirty)
                this.saveOne(p);
            else
                touch.run(Date.now(), p.x, p.y, p.mapId, p.charId);
        } })();
    }
    saveAll() { this.db.transaction(() => { for (const p of this.players.values())
        this.saveOne(p); })(); }
    onlineCount() { return this.players.size; }
}
