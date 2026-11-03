import { readFileSync } from 'node:fs';
import { join } from 'node:path';
export const ROOT = process.env.GAME_ROOT ?? process.cwd();
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'content', p), 'utf8'));
export function loadContent() {
    const idx = j('maps/index.json');
    const maps = {};
    for (const id of idx.maps)
        maps[id] = j(`maps/${id}.json`);
    const c = { classes: j('classes.json'), skills: j('skills.json'), items: j('items.json'), monsters: j('monsters.json'), drops: j('drops.json'), maps, startMap: idx.start,
        npcs: j('npcs.json'), shops: j('shops.json'), quests: j('quests.json'), achievements: j('achievements.json'), teleports: j('teleports.json'),
        recipes: j('recipes.json'), morphs: j('morphs.json'), pets: j('pets.json'), dailies: j('dailies.json') };
    validateContent(c);
    return c;
}
/** 啟動時檢查資料互相參照是否正確，錯了直接報錯 */
export function validateContent(c) {
    const err = [];
    for (const [id, cl] of Object.entries(c.classes)) {
        for (const s of cl.skills)
            if (!c.skills[s])
                err.push(`class ${id}: skill ${s} 不存在`);
        for (const it of cl.startItems)
            if (!c.items[it])
                err.push(`class ${id}: item ${it} 不存在`);
    }
    for (const [id, m] of Object.entries(c.monsters))
        if (!c.drops[m.drops])
            err.push(`monster ${id}: drop table ${m.drops} 不存在`);
    for (const [id, t] of Object.entries(c.drops))
        for (const e of t)
            if (!c.items[e.item])
                err.push(`drops ${id}: item ${e.item} 不存在`);
    for (const [id, s] of Object.entries(c.shops))
        for (const it of s.items)
            if (!c.items[it]?.price)
                err.push(`shop ${id}: ${it} 不存在或無價格`);
    for (const [id, n] of Object.entries(c.npcs))
        if (n.shop && !c.shops[n.shop])
            err.push(`npc ${id}: shop ${n.shop} 不存在`);
    for (const [id, q] of Object.entries(c.quests)) {
        if (!c.npcs[q.giver])
            err.push(`quest ${id}: giver ${q.giver}`);
        if (q.prereq && !c.quests[q.prereq])
            err.push(`quest ${id}: prereq ${q.prereq}`);
        const g = q.goal;
        if (g.kind === 'kill' && !c.monsters[g.monster])
            err.push(`quest ${id}: monster`);
        if (g.kind === 'collect' && !c.items[g.item])
            err.push(`quest ${id}: item`);
        if (g.kind === 'talk' && !c.npcs[g.npc])
            err.push(`quest ${id}: npc`);
        for (const [it] of q.reward.items ?? [])
            if (!c.items[it])
                err.push(`quest ${id}: reward ${it}`);
    }
    for (const t of c.teleports)
        if (!c.maps[t.map])
            err.push(`teleport → ${t.map}`);
    for (const m of Object.values(c.maps)) {
        if (m.rows.length !== m.height || m.rows.some(r => r.length !== m.width))
            err.push(`map ${m.id}: 尺寸不符`);
        for (const r of m.rows)
            for (const ch of r)
                if (!m.legend[ch]) {
                    err.push(`map ${m.id}: 未定義圖例 ${ch}`);
                    break;
                }
        for (const s of m.spawns)
            if (!c.monsters[s.monster])
                err.push(`map ${m.id}: monster ${s.monster} 不存在`);
        for (const p of m.portals)
            if (!c.maps[p.to])
                err.push(`map ${m.id}: portal → ${p.to} 不存在`);
        for (const n of m.npcs)
            if (!c.npcs[n.npc])
                err.push(`map ${m.id}: npc ${n.npc}`);
    }
    for (const [id, r] of Object.entries(c.recipes)) {
        if (!c.items[r.out])
            err.push(`recipe ${id}: out ${r.out}`);
        for (const [m] of r.mats)
            if (!c.items[m])
                err.push(`recipe ${id}: mat ${m}`);
    }
    for (const [id, d] of Object.entries(c.items)) {
        if (d.morph && !c.morphs[d.morph])
            err.push(`item ${id}: morph ${d.morph}`);
        if (d.pet && !c.pets[d.pet])
            err.push(`item ${id}: pet ${d.pet}`);
        if (d.tp && !c.maps[d.tp])
            err.push(`item ${id}: tp ${d.tp}`);
    }
    for (const [id, d] of Object.entries(c.dailies))
        for (const [it] of d.items ?? [])
            if (!c.items[it])
                err.push(`daily ${id}: ${it}`);
    for (const [id, cl] of Object.entries(c.classes))
        for (const a of cl.adv ?? [])
            if (!c.items[a.item])
                err.push(`class ${id}: adv item ${a.item}`);
    if (err.length)
        throw new Error('內容資料錯誤：\n' + err.join('\n'));
}
