import { addItem, canAdd, countItem, dailyReward, ENH_MAX, enhanceChance, enhanceCost, enhanceRoll, enhanceRisky, safeOf, INV_MAX, isGear, nextStreak, removeItem, sellPrice, sortInventory, taipeiDay } from '../shared/rules.js';
import { ChatLimiter, filterChat } from '../shared/chat.js';
import { saveItems } from './db.js';
const PARTY_MAX = 4;
export class Systems {
    w;
    parties = new Map();
    trades = new Map();
    partyInvites = new Map();
    tradeInvites = new Map();
    chat = new ChatLimiter();
    /** 由 Features 注入：額外的 NPC 對話選項 */
    extraOpts = () => ({});
    guildChat = () => { };
    seq = 0;
    constructor(w) {
        this.w = w;
        w.onTalk = (p, npc) => this.dialog(p, npc);
        w.hooks.onKill = (p, monster) => { this.questKill(p, monster); this.checkAch(p); };
        w.hooks.onLevel = p => this.checkAch(p);
        w.hooks.onLoot = (p, r) => { if (r >= 4) {
            p.counters.legend = (p.counters.legend ?? 0) + 1;
            this.checkAch(p);
        } if (r >= 3)
            this.system(`${p.name} 獲得了${r >= 4 ? '傳說' : '史詩'}級裝備！`); };
        w.hooks.onLeave = p => { this.cancelTrade(p, '對方已離線'); this.partyLeave(p); };
    }
    get c() { return this.w.c; }
    pl(charId) { return this.w.players.get(charId); }
    // ---------- NPC 對話 ----------
    dialog(p, npcId) {
        const n = this.c.npcs[npcId];
        for (const [qid, q] of Object.entries(this.c.quests))
            if (q.goal.kind === 'talk' && q.goal.npc === npcId && p.quests.active[qid] !== undefined && p.quests.active[qid] < 1) {
                p.quests.active[qid] = 1;
                p.progDirty = p.saveDirty = true;
                this.w.toast(p, `任務進度：${q.name}（完成，回報 ${this.c.npcs[q.giver].name}）`, 'good');
                p.conn.send({ t: 'dialog', npc: npcId, name: n.name, title: n.title, text: q.goal.text, opts: {} });
                return;
            }
        const quests = Object.entries(this.c.quests).filter(([, q]) => q.giver === npcId).map(([id, q]) => ({ id, state: this.questState(p, id), name: q.name, desc: q.desc, level: q.level, goal: q.goal, reward: q.reward, n: p.quests.active[id] ?? 0 })).filter(q => q.state !== 'locked');
        const line = n.lines?.length ? n.lines[Math.floor(Math.random() * n.lines.length)] : null;
        p.conn.send({ t: 'dialog', npc: npcId, name: n.name, title: n.title, text: line && Math.random() < 0.5 ? line : n.greet,
            opts: { shop: n.shop ? { id: n.shop, name: this.c.shops[n.shop].name, items: this.c.shops[n.shop].items } : undefined, quests: n.quests ? quests : undefined, teleport: n.teleport ? this.c.teleports.map(t => ({ ...t, name: this.c.maps[t.map]?.name })) : undefined, enhance: n.enhance || undefined, ...this.extraOpts(p, npcId) } });
    }
    questState(p, id) {
        const q = this.c.quests[id];
        if (p.quests.done.includes(id))
            return 'done';
        if (p.quests.active[id] !== undefined)
            return this.questReady(p, id) ? 'ready' : 'active';
        if ((q.prereq && !p.quests.done.includes(q.prereq)) || p.level < q.level - 2)
            return 'locked';
        return 'available';
    }
    questReady(p, id) {
        const g = this.c.quests[id].goal, n = p.quests.active[id] ?? 0;
        if (g.kind === 'kill')
            return n >= g.count;
        if (g.kind === 'collect')
            return countItem(p.inv, g.item) >= g.count;
        return n >= 1;
    }
    questAccept(p, id) {
        const q = this.c.quests[id];
        if (!q || !this.w.nearNpc(p, k => k === q.giver))
            return;
        if (this.questState(p, id) !== 'available')
            return;
        if (p.level < q.level) {
            this.w.log(p, `需要等級 ${q.level}`, 'warn');
            return;
        }
        if (Object.keys(p.quests.active).length >= 5) {
            this.w.log(p, '最多同時進行 5 個任務', 'warn');
            return;
        }
        p.quests.active[id] = 0;
        p.progDirty = p.saveDirty = true;
        this.w.toast(p, `接受任務：${q.name}`);
        this.dialog(p, q.giver);
    }
    questAbandon(p, id) { if (p.quests.active[id] === undefined)
        return; delete p.quests.active[id]; p.progDirty = p.saveDirty = true; }
    questTurnIn(p, id) {
        const q = this.c.quests[id];
        if (!q || !this.w.nearNpc(p, k => k === q.giver))
            return;
        if (this.questState(p, id) !== 'ready') {
            this.w.log(p, '任務尚未完成', 'warn');
            return;
        }
        const need = (q.reward.items ?? []).length + 1;
        if (p.inv.length + need > INV_MAX) {
            this.w.log(p, '背包空間不足，無法領取獎勵', 'warn');
            return;
        }
        if (q.goal.kind === 'collect')
            removeItem(p.inv, q.goal.item, q.goal.count);
        delete p.quests.active[id];
        p.quests.done.push(id);
        p.gold += q.reward.gold;
        for (const [k, n] of q.reward.items ?? [])
            addItem(p.inv, this.c.items, k, n);
        this.w.gainExp(p, q.reward.exp);
        p.counters.quests = (p.counters.quests ?? 0) + 1;
        this.w.hooks.onDaily?.(p, 'quests');
        this.w.markAll(p);
        this.w.toast(p, `任務完成：${q.name}（+${q.reward.exp} 經驗、+${q.reward.gold} 金幣）`, 'good');
        this.checkAch(p);
        this.w.saveOne(p);
        this.dialog(p, q.giver);
    }
    questKill(p, monster) {
        for (const id of Object.keys(p.quests.active)) {
            const g = this.c.quests[id].goal;
            if (g.kind === 'kill' && g.monster === monster && p.quests.active[id] < g.count) {
                p.quests.active[id]++;
                p.progDirty = true;
                if (p.quests.active[id] === g.count)
                    this.w.toast(p, `任務目標達成：${this.c.quests[id].name}`, 'good');
            }
        }
    }
    // ---------- 商店 / 強化 / 傳送 ----------
    shopBuy(p, npcId, key, qty) {
        const n = this.c.npcs[npcId];
        if (!n?.shop || !this.w.nearNpc(p, k => k === npcId))
            return;
        if (!this.c.shops[n.shop].items.includes(key))
            return;
        const d = this.c.items[key];
        qty = Math.max(1, Math.min(d.stack ? 999 : 1, Math.floor(qty)));
        const cost = (d.price ?? 0) * qty;
        if (p.gold < cost) {
            this.w.log(p, '金幣不足', 'warn');
            return;
        }
        if (!canAdd(p.inv, this.c.items, { key, qty })) {
            this.w.log(p, '背包已滿', 'warn');
            return;
        }
        p.gold -= cost;
        addItem(p.inv, this.c.items, key, qty);
        this.w.markAll(p);
        this.w.log(p, `購買 ${d.name} ×${qty}（-${cost} 金幣）`);
        this.w.saveOne(p);
        this.checkAch(p);
    }
    shopSell(p, uid, qty) {
        if (!this.w.nearNpc(p, k => !!this.c.npcs[k].shop)) {
            this.w.log(p, '請在商人附近販賣', 'warn');
            return;
        }
        if (p.tradeId !== null)
            return;
        const it = p.inv.find(i => i.uid === uid);
        if (!it)
            return;
        const d = this.c.items[it.key];
        if (d.type === 'quest') {
            this.w.log(p, '任務物品無法販賣', 'warn');
            return;
        }
        qty = Math.max(1, Math.min(it.qty, Math.floor(qty)));
        const gain = sellPrice(d, it) * qty;
        it.qty -= qty;
        if (it.qty <= 0)
            p.inv.splice(p.inv.indexOf(it), 1);
        p.gold += gain;
        this.w.markAll(p);
        this.w.log(p, `販賣 ${d.name} ×${qty}（+${gain} 金幣）`);
        this.w.saveOne(p);
        this.checkAch(p);
    }
    enhance(p, uid, bless, guard = false) {
        if (!this.w.nearNpc(p, k => !!this.c.npcs[k].enhance)) {
            this.w.log(p, '請在鍛造師附近強化', 'warn');
            return;
        }
        if (p.tradeId !== null)
            return;
        const inInv = p.inv.find(i => i.uid === uid), slot = Object.keys(p.eq).find(s => p.eq[s]?.uid === uid);
        const it = inInv ?? (slot ? p.eq[slot] : undefined);
        if (!it)
            return;
        const d = this.c.items[it.key];
        if (!isGear(d))
            return;
        const cur = it.enh ?? 0;
        if (cur >= ENH_MAX) {
            this.w.log(p, '已達強化上限', 'warn');
            return;
        }
        const safe = safeOf(d), cost = enhanceCost(d, cur);
        if (p.gold < cost.gold || countItem(p.inv, 'st_enh') < cost.stones) {
            this.w.log(p, `需要 ${cost.gold} 金幣與 ${cost.stones} 顆星砂強化石`, 'warn');
            return;
        }
        const useBless = bless && cur >= safe && countItem(p.inv, 'st_bless') > 0;
        const useGuard = guard && enhanceRisky(cur, safe) && countItem(p.inv, 'st_guard') > 0;
        p.gold -= cost.gold;
        removeItem(p.inv, 'st_enh', cost.stones);
        if (useBless)
            removeItem(p.inv, 'st_bless', 1);
        if (useGuard)
            removeItem(p.inv, 'st_guard', 1);
        const r = enhanceRoll(cur, this.w.rng, useBless, safe, useGuard);
        this.w.hooks.onDaily?.(p, 'enhance');
        if (r.destroyed) {
            if (inInv)
                p.inv.splice(p.inv.indexOf(it), 1);
            else if (slot)
                delete p.eq[slot];
            this.w.refreshStats(p);
            p.progDirty = true;
            p.conn.send({ t: 'enhResult', ok: false, uid, enh: 0, chance: enhanceChance(cur, safe), protectedUsed: false, destroyed: true });
            this.w.log(p, `強化失敗！${d.name} +${cur} 化為灰燼…`, 'bad');
            if (cur >= 7)
                this.system(`${p.name} 的 ${d.name} +${cur} 在強化中碎裂了…`);
            this.checkAch(p);
            this.w.saveOne(p);
            return;
        }
        if (r.next > 0)
            it.enh = r.next;
        else
            delete it.enh;
        p.counters.maxEnh = Math.max(p.counters.maxEnh ?? 0, it.enh ?? 0);
        this.w.refreshStats(p);
        p.progDirty = true;
        p.conn.send({ t: 'enhResult', ok: r.ok, uid, enh: it.enh ?? 0, chance: enhanceChance(cur, safe), protectedUsed: r.protectedUsed, guardUsed: r.guardUsed });
        this.w.log(p, r.ok ? `強化成功！${d.name} +${it.enh}` : `強化失敗…${d.name} ${it.enh ? '+' + it.enh : ''}${r.guardUsed ? '（守護之符保住了裝備）' : ''}`, r.ok ? 'good' : 'warn');
        if (r.ok && (it.enh ?? 0) >= safe + 3)
            this.system(`${p.name} 將 ${d.name} 強化至 +${it.enh}！`);
        this.checkAch(p);
        this.w.saveOne(p);
    }
    teleport(p, idx) {
        const t = this.c.teleports[idx];
        if (!t || !this.w.nearNpc(p, k => !!this.c.npcs[k].teleport))
            return;
        if (p.level < t.level) {
            this.w.log(p, `需要等級 ${t.level}`, 'warn');
            return;
        }
        if (p.gold < t.cost) {
            this.w.log(p, '金幣不足', 'warn');
            return;
        }
        p.gold -= t.cost;
        this.w.travel(p, t.map, t.x + 0.5, t.y + 0.5);
        p.saveDirty = true;
    }
    sortInv(p) { if (p.tradeId !== null)
        return; p.inv = sortInventory(p.inv, this.c.items); p.invDirty = p.saveDirty = true; }
    discard(p, uid) { if (p.tradeId !== null)
        return; const i = p.inv.findIndex(x => x.uid === uid); if (i >= 0) {
        const d = this.c.items[p.inv[i].key];
        p.inv.splice(i, 1);
        p.invDirty = p.saveDirty = true;
        this.w.log(p, `丟棄 ${d.name}`);
    } }
    settings(p, s) {
        if (typeof s.autoPickup === 'boolean')
            p.settings.autoPickup = s.autoPickup;
        if (typeof s.autoSkills === 'boolean')
            p.settings.autoSkills = s.autoSkills;
        if (typeof s.pickupRare === 'boolean')
            p.settings.pickupRare = s.pickupRare;
        if (typeof s.autoPotionPct === 'number' && Number.isFinite(s.autoPotionPct))
            p.settings.autoPotionPct = Math.max(0, Math.min(90, Math.round(s.autoPotionPct)));
        p.progDirty = p.saveDirty = true;
    }
    // ---------- 每日 / 成就 ----------
    dailyClaim(p) {
        const today = taipeiDay(Date.now());
        if (p.daily.last === today) {
            this.w.log(p, '今天已經領過了', 'warn');
            return;
        }
        const streak = nextStreak(p.daily.last, p.daily.streak, today), rw = dailyReward(streak);
        if (p.inv.length + rw.items.length > INV_MAX) {
            this.w.log(p, '背包已滿', 'warn');
            return;
        }
        p.daily = { last: today, streak };
        p.gold += rw.gold;
        for (const [k, n] of rw.items)
            addItem(p.inv, this.c.items, k, n);
        this.w.markAll(p);
        this.w.toast(p, `每日簽到第 ${streak} 天：+${rw.gold} 金幣、${rw.items.map(([k, n]) => this.c.items[k].name + '×' + n).join('、')}`, 'good');
        this.checkAch(p);
        this.w.saveOne(p);
    }
    checkAch(p) {
        for (const [id, a] of Object.entries(this.c.achievements)) {
            if (p.ach.done.includes(id))
                continue;
            const v = a.kind === 'kills' ? p.counters.kills : a.kind === 'level' ? p.level : a.kind === 'boss' ? p.counters.bosses : a.kind === 'enhance' ? p.counters.maxEnh
                : a.kind === 'party' ? p.counters.party : a.kind === 'trade' ? p.counters.trades : a.kind === 'quests' ? p.counters.quests : a.kind === 'gold' ? p.gold : p.counters.legend;
            if ((v ?? 0) >= a.n) {
                p.ach.done.push(id);
                p.gold += a.gold;
                this.w.markAll(p);
                this.w.toast(p, `🏆 成就達成：${a.name}（+${a.gold} 金幣）`, 'ach');
            }
        }
    }
    // ---------- 聊天 ----------
    system(text) { for (const o of this.w.players.values())
        o.conn.send({ t: 'chat', ch: 'system', from: '系統', text, ts: Date.now() }); }
    say(p, ch, raw) {
        const text = filterChat(raw);
        if (!text)
            return;
        const r = this.chat.check(String(p.charId), text, Date.now());
        if (r !== 'ok') {
            this.w.log(p, r === 'rate' ? '發言太快了，請稍候' : '請勿重複發送相同訊息', 'warn');
            return;
        }
        const msg = { t: 'chat', ch, from: p.name, fromId: p.id, text, ts: Date.now() };
        if (ch === 'world')
            for (const o of this.w.players.values())
                o.conn.send(msg);
        else if (ch === 'near') {
            for (const o of this.w.mapOf(p).players)
                if (Math.hypot(o.x - p.x, o.y - p.y) <= 20)
                    o.conn.send(msg);
        }
        else if (ch === 'guild') {
            this.guildChat(p, text);
        }
        else if (ch === 'party') {
            const pt = p.partyId !== null ? this.parties.get(p.partyId) : undefined;
            if (!pt) {
                this.w.log(p, '你不在隊伍中', 'warn');
                return;
            }
            for (const id of pt.members)
                this.pl(id)?.conn.send(msg);
        }
    }
    // ---------- 隊伍 ----------
    sendParty(pt, extra) {
        const list = pt ? pt.members.map(id => { const o = this.pl(id); return { id: o.id, name: o.name, job: o.job, lv: o.level, hp: o.hp, mhp: o.stats.maxHp, map: o.mapId, leader: id === pt.leader }; }) : [];
        if (pt)
            for (const id of pt.members)
                this.pl(id)?.conn.send({ t: 'party', members: list });
        extra?.conn.send({ t: 'party', members: [] });
    }
    partyTick() { for (const pt of this.parties.values())
        this.sendParty(pt); }
    partyInvite(p, name) {
        const o = this.w.byName(name);
        if (!o || o === p) {
            this.w.log(p, '找不到該玩家（需在線上）', 'warn');
            return;
        }
        if (o.partyId !== null) {
            this.w.log(p, `${o.name} 已在其他隊伍`, 'warn');
            return;
        }
        const pt = p.partyId !== null ? this.parties.get(p.partyId) : undefined;
        if (pt && pt.leader !== p.charId) {
            this.w.log(p, '只有隊長能邀請', 'warn');
            return;
        }
        if (pt && pt.members.length >= PARTY_MAX) {
            this.w.log(p, '隊伍已滿（4 人）', 'warn');
            return;
        }
        this.partyInvites.set(o.charId, { from: p.charId, at: Date.now() });
        o.conn.send({ t: 'invite', kind: 'party', from: p.name, fromId: p.charId });
        this.w.log(p, `已邀請 ${o.name} 加入隊伍`);
    }
    partyRespond(p, accept) {
        const inv = this.partyInvites.get(p.charId);
        this.partyInvites.delete(p.charId);
        const from = inv && Date.now() - inv.at < 60000 ? this.pl(inv.from) : undefined;
        if (!from)
            return;
        if (!accept) {
            this.w.log(from, `${p.name} 拒絕了隊伍邀請`);
            return;
        }
        if (p.partyId !== null)
            return;
        let pt = from.partyId !== null ? this.parties.get(from.partyId) : undefined;
        if (!pt) {
            pt = { id: ++this.seq, leader: from.charId, members: [from.charId] };
            this.parties.set(pt.id, pt);
            from.partyId = pt.id;
            from.counters.party = (from.counters.party ?? 0) + 1;
            this.checkAch(from);
        }
        if (pt.members.length >= PARTY_MAX) {
            this.w.log(p, '隊伍已滿', 'warn');
            return;
        }
        pt.members.push(p.charId);
        p.partyId = pt.id;
        p.counters.party = (p.counters.party ?? 0) + 1;
        this.checkAch(p);
        for (const id of pt.members) {
            const o = this.pl(id);
            if (o) {
                this.w.log(o, `${p.name} 加入了隊伍`, 'good');
                o.selfDirty = true;
            }
        }
        this.sendParty(pt);
    }
    partyLeave(p) {
        if (p.partyId === null)
            return;
        const pt = this.parties.get(p.partyId);
        p.partyId = null;
        if (!pt)
            return;
        pt.members = pt.members.filter(id => id !== p.charId);
        for (const id of pt.members) {
            const o = this.pl(id);
            if (o)
                this.w.log(o, `${p.name} 離開了隊伍`);
        }
        if (pt.members.length <= 1) {
            for (const id of pt.members) {
                const o = this.pl(id);
                if (o) {
                    o.partyId = null;
                    o.conn.send({ t: 'party', members: [] });
                }
            }
            this.parties.delete(pt.id);
        }
        else {
            if (pt.leader === p.charId)
                pt.leader = pt.members[0];
            this.sendParty(pt);
        }
        p.conn.send({ t: 'party', members: [] });
    }
    partyKick(p, name) {
        const pt = p.partyId !== null ? this.parties.get(p.partyId) : undefined;
        const o = this.w.byName(name);
        if (!pt || pt.leader !== p.charId || !o || o.partyId !== pt.id || o === p)
            return;
        this.w.log(o, '你被移出隊伍', 'warn');
        this.partyLeave(o);
    }
    // ---------- 交易（兩段式確認：鎖定 → 確認） ----------
    tradeOf(p) { return p.tradeId !== null ? this.trades.get(p.tradeId) : undefined; }
    sides(t, p) { return t.a.charId === p.charId ? [t.a, t.b] : [t.b, t.a]; }
    sendTrade(t) {
        const view = (s) => ({ name: this.pl(s.charId)?.name, gold: s.gold, locked: s.locked, confirmed: s.confirmed,
            items: s.items.map(([uid, qty]) => { const it = this.pl(s.charId)?.inv.find(i => i.uid === uid); return it ? { ...it, qty } : null; }).filter(Boolean) });
        for (const [me, other] of [[t.a, t.b], [t.b, t.a]])
            this.pl(me.charId)?.conn.send({ t: 'trade', open: true, me: view(me), other: view(other) });
    }
    tradeRequest(p, name) {
        const o = this.w.byName(name);
        if (!o || o === p) {
            this.w.log(p, '找不到該玩家（需在線上）', 'warn');
            return;
        }
        if (o.mapId !== p.mapId || Math.hypot(o.x - p.x, o.y - p.y) > 12) {
            this.w.log(p, '對方需在附近（12 格內）', 'warn');
            return;
        }
        if (p.tradeId !== null || o.tradeId !== null) {
            this.w.log(p, '對方或你正在交易中', 'warn');
            return;
        }
        this.tradeInvites.set(o.charId, { from: p.charId, at: Date.now() });
        o.conn.send({ t: 'invite', kind: 'trade', from: p.name, fromId: p.charId });
        this.w.log(p, `已向 ${o.name} 提出交易`);
    }
    tradeRespond(p, accept) {
        const inv = this.tradeInvites.get(p.charId);
        this.tradeInvites.delete(p.charId);
        const o = inv && Date.now() - inv.at < 60000 ? this.pl(inv.from) : undefined;
        if (!o)
            return;
        if (!accept) {
            this.w.log(o, `${p.name} 拒絕交易`);
            return;
        }
        if (p.tradeId !== null || o.tradeId !== null)
            return;
        const side = (id) => ({ charId: id, items: [], gold: 0, locked: false, confirmed: false });
        const t = { id: ++this.seq, a: side(o.charId), b: side(p.charId), open: true };
        this.trades.set(t.id, t);
        o.tradeId = p.tradeId = t.id;
        this.sendTrade(t);
    }
    tradeOffer(p, items, gold) {
        const t = this.tradeOf(p);
        if (!t)
            return;
        const [me] = this.sides(t, p);
        const clean = [];
        for (const [uid, q] of items.slice(0, 12)) {
            const it = p.inv.find(i => i.uid === uid);
            if (!it || clean.some(c => c[0] === uid))
                continue;
            if (this.c.items[it.key].noTrade || this.c.items[it.key].type === 'quest')
                continue;
            clean.push([uid, Math.max(1, Math.min(it.qty, Math.floor(q)))]);
        }
        me.items = clean;
        me.gold = Math.max(0, Math.min(p.gold, Math.floor(gold) || 0));
        t.a.locked = t.b.locked = t.a.confirmed = t.b.confirmed = false; // 任何變動都重置鎖定
        this.sendTrade(t);
    }
    tradeLock(p) { const t = this.tradeOf(p); if (!t)
        return; this.sides(t, p)[0].locked = true; this.sendTrade(t); }
    tradeConfirm(p) {
        const t = this.tradeOf(p);
        if (!t)
            return;
        if (!t.a.locked || !t.b.locked) {
            this.w.log(p, '雙方都鎖定後才能確認', 'warn');
            return;
        }
        this.sides(t, p)[0].confirmed = true;
        if (t.a.confirmed && t.b.confirmed)
            this.execTrade(t);
        else
            this.sendTrade(t);
    }
    cancelTrade(p, why = '交易已取消') {
        const t = this.tradeOf(p);
        if (!t)
            return;
        this.trades.delete(t.id);
        for (const s of [t.a, t.b]) {
            const o = this.pl(s.charId);
            if (o) {
                o.tradeId = null;
                o.conn.send({ t: 'trade', open: false });
                if (o !== p)
                    this.w.log(o, why, 'warn');
            }
        }
    }
    execTrade(t) {
        const A = this.pl(t.a.charId), B = this.pl(t.b.charId);
        if (!A || !B)
            return;
        const take = (p, s) => {
            if (p.gold < s.gold)
                return null;
            const out = [];
            for (const [uid, q] of s.items) {
                const it = p.inv.find(i => i.uid === uid);
                if (!it || it.qty < q)
                    return null;
                out.push({ ...it, qty: q });
            }
            return out;
        };
        const ga = take(A, t.a), gb = take(B, t.b);
        const fits = (p, give, get) => { const sim = p.inv.filter(i => !give.some(([u, q]) => u === i.uid && q >= i.qty)).map(i => ({ ...i })); return get.every(g => addItem(sim, this.c.items, g.key, g.qty, { r: g.r, aff: g.aff, enh: g.enh })); };
        if (!ga || !gb || !fits(A, t.a.items, gb) || !fits(B, t.b.items, ga)) {
            this.w.log(A, '交易失敗（物品變動或背包空間不足）', 'warn');
            this.w.log(B, '交易失敗（物品變動或背包空間不足）', 'warn');
            this.cancelTrade(A, '交易失敗');
            return;
        }
        const move = (from, to, s) => {
            for (const [uid, q] of s.items) {
                const it = from.inv.find(i => i.uid === uid);
                if (q >= it.qty) {
                    from.inv.splice(from.inv.indexOf(it), 1);
                    if (this.c.items[it.key].stack && to.inv.some(i => i.key === it.key))
                        addItem(to.inv, this.c.items, it.key, q);
                    else
                        to.inv.push(it);
                }
                else {
                    it.qty -= q;
                    addItem(to.inv, this.c.items, it.key, q, { r: it.r, aff: it.aff, enh: it.enh });
                }
            }
            from.gold -= s.gold;
            to.gold += s.gold;
        };
        move(A, B, t.a);
        move(B, A, t.b);
        // 原子寫入：兩邊同一個 transaction
        this.w.db.transaction(() => { for (const p of [A, B]) {
            this.w.db.prepare('UPDATE characters SET gold=? WHERE id=?').run(p.gold, p.charId);
            saveItems(this.w.db, p.charId, p.inv, p.eq);
        } })();
        for (const p of [A, B]) {
            p.counters.trades = (p.counters.trades ?? 0) + 1;
            this.w.markAll(p);
            this.w.toast(p, '交易完成', 'good');
            this.checkAch(p);
        }
        this.trades.delete(t.id);
        A.tradeId = B.tradeId = null;
        A.conn.send({ t: 'trade', open: false, done: true });
        B.conn.send({ t: 'trade', open: false, done: true });
    }
}
