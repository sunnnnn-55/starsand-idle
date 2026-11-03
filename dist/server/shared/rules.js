/** 可重現的亂數（mulberry32） */
export function seededRng(seed) {
    return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export const MAX_LEVEL = 60;
export function expToNext(level) { return Math.round(30 * Math.pow(level, 2.1) + 20); }
export const RARITY_NAMES = ['普通', '精良', '稀有', '史詩', '傳說'];
export const RARITY_COLORS = ['#e8e4dc', '#5ee36a', '#4aa8ff', '#c070ff', '#ffa030'];
export const GEAR_TYPES = new Set(['weapon', 'armor', 'helm', 'boots', 'ring', 'amulet']);
export const isGear = (d) => !!d && GEAR_TYPES.has(d.type);
// ---------- 裝備數值 ----------
const ENH_STATS = ['atk', 'def', 'hp', 'mp'];
/** 單件裝備的實際加成：基礎 × (1 + 8%×強化)（每級至少 +1），再加詞綴 */
export function itemStats(def, inst) {
    const enh = inst?.enh ?? 0, out = {};
    for (const k of ENH_STATS) {
        const b = def[k] ?? 0;
        if (b)
            out[k] = b + Math.max(enh, Math.round(b * 0.08 * enh));
    }
    if (def.crit)
        out.crit = def.crit;
    for (const [k, v] of inst?.aff ?? [])
        out[k] = (out[k] ?? 0) + v;
    return out;
}
export function computeStats(cls, level, equipped, buffs = [], now = 0) {
    const g = (p) => p[0] + p[1] * (level - 1);
    const s = { atk: g(cls.atk), def: g(cls.def), hp: g(cls.hp), mp: g(cls.mp), crit: 0.05, aspd: 0, speed: 0 };
    for (const e of equipped) {
        if (!e)
            continue;
        for (const [k, v] of Object.entries(itemStats(e.def, e.inst)))
            s[k] += v;
    }
    for (const b of buffs)
        if (b.until > now) {
            if (b.stat === 'crit' || b.stat === 'aspd' || b.stat === 'speed')
                s[b.stat] += b.pct;
            else
                s[b.stat] *= 1 + b.pct;
        }
    return { maxHp: Math.round(s.hp), maxMp: Math.round(s.mp), atk: Math.round(s.atk), def: Math.round(s.def), crit: Math.min(0.75, s.crit), range: cls.range,
        attackMs: Math.round(cls.attackMs / (1 + s.aspd)), speed: cls.speed * (1 + s.speed + s.aspd * 0.5) };
}
/** 傷害 = 攻 × 倍率 × (0.9~1.1)（暴擊 ×1.6）− 防 × 0.5；最低為攻擊的 10%（至少 1） */
export function computeDamage(atk, def, mult, rng, crit = 0.05, forceCrit = false) {
    const base = atk * mult * (0.9 + rng() * 0.2);
    const c = forceCrit || rng() < crit;
    const raw = (c ? base * 1.6 : base) - def * 0.5;
    return { amount: Math.max(1, Math.round(Math.max(raw, atk * mult * 0.1))), crit: c };
}
/** 技能倍率：基礎 × (1 + 每級加成 × (等級−1)) */
export function skillMult(sk, rank) { return (sk.mult ?? 1) * (1 + (sk.perRank ?? 0.12) * Math.max(0, rank - 1)); }
export function skillBuffPct(sk, rank) { return (sk.buff?.pct ?? 0) + (sk.perRank ?? 0) * Math.max(0, rank - 1); }
export function skillPointsFor(level) { return Math.max(0, level - 1) + 1; }
export function rollDrops(table, rng) {
    const out = [];
    for (const e of table ?? [])
        if (rng() < e.chance) {
            const min = e.min ?? 1, max = e.max ?? min;
            out.push({ key: e.item, qty: min + Math.floor(rng() * (max - min + 1)) });
        }
    return out;
}
export function rollGold(range, rng) { return range[0] + Math.floor(rng() * (range[1] - range[0] + 1)); }
/** 品質：普通 60% / 精良 25% / 稀有 10% / 史詩 4% / 傳說 1%；bonus（首領）往上偏移 */
export function rollRarity(rng, bonus = 0) {
    const v = rng() * (1 - bonus * 0.6);
    return v < 0.01 ? 4 : v < 0.05 ? 3 : v < 0.15 ? 2 : v < 0.4 ? 1 : 0;
}
const AFF_POOL = { weapon: ['atk', 'crit', 'aspd', 'hp'], armor: ['def', 'hp', 'mp', 'speed'], helm: ['def', 'hp', 'mp'], boots: ['speed', 'def', 'hp'], ring: ['atk', 'crit', 'mp', 'aspd'], amulet: ['hp', 'atk', 'crit', 'def'] };
/** 詞綴數量 = 品質（0~4），數值依需求等級縮放 */
export function rollAffixes(def, r, rng) {
    const pool = [...(AFF_POOL[def.type] ?? [])], lv = def.req ?? 1, out = [];
    for (let i = 0; i < r && pool.length; i++) {
        const k = pool.splice(Math.floor(rng() * pool.length), 1)[0], q = 0.6 + rng() * 0.6;
        const v = k === 'crit' ? +(0.01 + lv * 0.0008 * q).toFixed(3) : k === 'aspd' || k === 'speed' ? +(0.03 + lv * 0.0015 * q).toFixed(3)
            : k === 'hp' ? Math.round((10 + lv * 5) * q) : k === 'mp' ? Math.round((6 + lv * 3) * q) : Math.round((2 + lv * 0.9) * q * (k === 'def' ? 0.8 : 1));
        out.push([k, v]);
    }
    return out;
}
/** 掉落物套上品質與詞綴（只對裝備） */
export function finalizeLoot(l, items, rng, bonus = 0) {
    const d = items[l.key];
    if (!isGear(d))
        return l;
    const r = rollRarity(rng, bonus);
    return r ? { ...l, r, aff: rollAffixes(d, r, rng) } : l;
}
// ---------- 經驗 ----------
export function applyExp(ch, gained) {
    let ups = 0;
    ch.exp += Math.max(0, Math.floor(gained));
    while (ch.level < MAX_LEVEL && ch.exp >= expToNext(ch.level)) {
        ch.exp -= expToNext(ch.level);
        ch.level++;
        ups++;
    }
    if (ch.level >= MAX_LEVEL)
        ch.exp = Math.min(ch.exp, expToNext(MAX_LEVEL) - 1);
    return ups;
}
/** 死亡懲罰：扣除本級需求經驗 5%（不降級） */
export function deathPenalty(ch) { const lost = Math.min(ch.exp, Math.floor(expToNext(ch.level) * 0.05)); ch.exp -= lost; return lost; }
/** 隊伍經驗：總經驗 × (1 + 0.1×(n−1)) ÷ n */
export function partyShare(total, n) { return n <= 1 ? total : Math.floor((total * (1 + 0.1 * (n - 1))) / n); }
// ---------- 背包 ----------
export const INV_MAX = 48;
let uidSeq = 1;
export function setUidBase(n) { uidSeq = Math.max(uidSeq, n); }
export function newUid() { return ++uidSeq; }
const plain = (i) => !i.r && !i.aff?.length && !i.enh;
/** 背包需要幾個新格子 */
export function slotsNeeded(inv, items, l) {
    const d = items[l.key];
    if (!d)
        return Infinity;
    const stack = d.stack ?? 1;
    if (stack <= 1 || l.r)
        return l.qty;
    let q = l.qty;
    for (const i of inv)
        if (i.key === l.key && plain(i))
            q -= Math.max(0, stack - i.qty);
    return q <= 0 ? 0 : Math.ceil(q / stack);
}
export function canAdd(inv, items, l) { return inv.length + slotsNeeded(inv, items, l) <= INV_MAX; }
/** 放入背包（可堆疊者合併）；放不下時不做任何變更並回傳 false */
export function addItem(inv, items, key, qty, extra = {}) {
    const d = items[key];
    if (!d || qty <= 0)
        return false;
    if (!canAdd(inv, items, { key, qty, r: extra.r }))
        return false;
    const stack = d.stack ?? 1;
    if (stack > 1 && !extra.r) {
        for (const ex of inv) {
            if (qty <= 0)
                break;
            if (ex.key === key && plain(ex) && ex.qty < stack) {
                const a = Math.min(qty, stack - ex.qty);
                ex.qty += a;
                qty -= a;
            }
        }
        while (qty > 0) {
            const a = Math.min(qty, stack);
            inv.push({ uid: newUid(), key, qty: a });
            qty -= a;
        }
        return true;
    }
    for (let i = 0; i < qty; i++) {
        const it = { uid: newUid(), key, qty: 1 };
        if (extra.r)
            it.r = extra.r;
        if (extra.aff?.length)
            it.aff = extra.aff;
        if (extra.enh)
            it.enh = extra.enh;
        inv.push(it);
    }
    return true;
}
export function countItem(inv, key) { return inv.reduce((s, i) => s + (i.key === key ? i.qty : 0), 0); }
/** 移除指定數量（從後往前）；不足回傳 false 且不變更 */
export function removeItem(inv, key, qty) {
    if (countItem(inv, key) < qty)
        return false;
    for (let i = inv.length - 1; i >= 0 && qty > 0; i--)
        if (inv[i].key === key) {
            const t = Math.min(qty, inv[i].qty);
            inv[i].qty -= t;
            qty -= t;
            if (inv[i].qty <= 0)
                inv.splice(i, 1);
        }
    return true;
}
const TYPE_ORDER = ['weapon', 'armor', 'helm', 'boots', 'ring', 'amulet', 'potion', 'scroll', 'stone', 'material', 'quest'];
/** 整理：依類型→品質（高到低）→名稱排序，並合併可堆疊物品 */
export function sortInventory(inv, items) {
    const merged = [];
    for (const it of inv) {
        const d = items[it.key];
        const st = d?.stack ?? 1;
        const ex = st > 1 && plain(it) ? merged.find(m => m.key === it.key && plain(m) && m.qty < st) : undefined;
        if (ex) {
            const a = Math.min(it.qty, st - ex.qty);
            ex.qty += a;
            if (it.qty - a > 0)
                merged.push({ ...it, qty: it.qty - a });
        }
        else
            merged.push({ ...it });
    }
    return merged.sort((a, b) => {
        const da = items[a.key], db = items[b.key];
        return TYPE_ORDER.indexOf(da.type) - TYPE_ORDER.indexOf(db.type) || (b.r ?? 0) - (a.r ?? 0) || (db.req ?? 0) - (da.req ?? 0) || a.key.localeCompare(b.key) || (b.enh ?? 0) - (a.enh ?? 0);
    });
}
export function sellPrice(d, inst) { return Math.floor((d.sell ?? Math.floor((d.price ?? 0) / 4)) * (1 + (inst?.r ?? 0) * 0.5 + (inst?.enh ?? 0) * 0.2)); }
// ---------- 強化 ----------
export const ENH_MAX = 12;
/** 預設安定值：武器 6、防具/頭盔/靴子 4、飾品 0 */
export function safeOf(d) { return d.safe ?? (d.type === 'weapon' ? 6 : d.type === 'ring' || d.type === 'amulet' ? 0 : 4); }
/** 未給安定值時為舊規則（+1~+3 必成功，之後 90/80/…/30%）；
 *  給安定值時：安定值以內必成功，超過後 90% 起每級 -12%（最低 25%） */
export function enhanceChance(cur, safe) {
    if (safe === undefined)
        return cur < 3 ? 1 : Math.max(0.3, 1 - (cur - 2) * 0.1);
    return cur < safe ? 1 : Math.max(0.25, 0.9 - (cur - safe) * 0.12);
}
export function enhanceCost(d, cur) { return { gold: Math.round((50 + (d.req ?? 1) * 20) * (cur + 1) * (cur + 1) * 0.5), stones: 1 + Math.floor(cur / 3) }; }
/** 未給安定值：+6 以上失敗會降 1 級（祝福石保護）。
 *  給安定值：超過安定值失敗降 1 級（祝福石保護不降）；強化值 ≥ 安定值+3 時失敗會「損毀」，守護之符可改為僅降 1 級 */
export function enhanceRoll(cur, rng, blessed, safe, guard = false) {
    if (rng() < enhanceChance(cur, safe))
        return { ok: true, next: cur + 1, protectedUsed: false };
    if (safe === undefined) {
        if (cur >= 6)
            return blessed ? { ok: false, next: cur, protectedUsed: true } : { ok: false, next: cur - 1, protectedUsed: false };
        return { ok: false, next: cur, protectedUsed: false };
    }
    if (cur >= safe + 3) {
        if (!guard)
            return { ok: false, next: 0, protectedUsed: false, destroyed: true };
        return blessed ? { ok: false, next: cur, protectedUsed: true, guardUsed: true } : { ok: false, next: cur - 1, protectedUsed: false, guardUsed: true };
    }
    return blessed ? { ok: false, next: cur, protectedUsed: true } : { ok: false, next: Math.max(0, cur - 1), protectedUsed: false };
}
/** 是否處於可能損毀的區間 */
export const enhanceRisky = (cur, safe) => cur >= safe + 3;
// ---------- 每日獎勵 ----------
/** 以台北時間為準的日期字串 */
export function taipeiDay(ms) { return new Date(ms + 8 * 3600e3).toISOString().slice(0, 10); }
export function dailyReward(streak) { const d = ((streak - 1) % 7) + 1; return { gold: 100 * d * d, items: d === 7 ? [['st_bless', 1]] : d % 2 === 0 ? [['st_enh', d / 2]] : [['p_hp', 5 * d]] }; }
export function nextStreak(lastDay, streak, today) {
    if (lastDay === today)
        return null;
    const y = new Date(Date.parse(today) - 86400e3).toISOString().slice(0, 10);
    return lastDay === y ? streak + 1 : 1;
}
// ---------- 離線結算 ----------
export const OFFLINE_CAP_SEC = 12 * 3600;
export const OFFLINE_EFFICIENCY = 0.35;
/** 依單隻擊殺時間估算擊殺數；效率 35%、上限 12 小時；首領不列入；背包放不下的戰利品自動換成金幣 */
export function settleOffline(c, inp, rng) {
    const seconds = Math.max(0, Math.min(OFFLINE_CAP_SEC, Math.floor(inp.seconds)));
    const res = { seconds, monster: null, kills: 0, exp: 0, gold: 0, loot: [], levelsGained: 0, level: inp.level, expAfter: inp.exp, soldGold: 0 };
    if (seconds < 60)
        return res;
    let best = null;
    for (const id of new Set(inp.mapMonsters)) {
        const m = c.monsters[id];
        if (!m || m.rank)
            continue;
        const hit = Math.max(inp.stats.atk * 0.1, inp.stats.atk * 1.05 - m.def * 0.5), hits = Math.ceil(m.hp / hit);
        const killSec = (hits * inp.stats.attackMs) / 1000 + 3;
        const taken = Math.max(m.atk * 0.1, m.atk - inp.stats.def * 0.5) * (killSec * 1000 / m.attackMs);
        if (taken > inp.stats.maxHp * 0.6)
            continue;
        const rate = m.exp / killSec;
        if (!best || rate > best.rate)
            best = { id, killSec, rate };
    }
    if (!best)
        return res;
    const m = c.monsters[best.id];
    const kills = Math.floor((seconds / best.killSec) * OFFLINE_EFFICIENCY);
    res.monster = best.id;
    res.kills = kills;
    res.exp = kills * m.exp;
    const inv = (inp.inv ?? []).map(i => ({ ...i }));
    const lootMap = new Map();
    for (let i = 0; i < kills; i++) {
        res.gold += rollGold(m.gold, rng);
        for (const l0 of rollDrops(c.drops[m.drops], rng)) {
            const l = finalizeLoot(l0, c.items, rng);
            if (addItem(inv, c.items, l.key, l.qty, { r: l.r, aff: l.aff })) {
                if (!l.r)
                    lootMap.set(l.key, (lootMap.get(l.key) ?? 0) + l.qty);
                else
                    res.loot.push(l);
            }
            else
                res.soldGold += sellPrice(c.items[l.key], { uid: 0, key: l.key, qty: 1, r: l.r }) * l.qty;
        }
    }
    res.loot.push(...[...lootMap].map(([key, qty]) => ({ key, qty })));
    const ch = { level: inp.level, exp: inp.exp };
    res.levelsGained = applyExp(ch, res.exp);
    res.level = ch.level;
    res.expAfter = ch.exp;
    return res;
}
