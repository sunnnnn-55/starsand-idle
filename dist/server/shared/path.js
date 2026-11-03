// 格子 A*（8 方向、禁止切角），前後端共用
export class WalkGrid {
    w;
    h;
    cells;
    constructor(w, h, cells) {
        this.w = w;
        this.h = h;
        this.cells = cells;
    }
    ok(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h && this.cells[y * this.w + x] === 1; }
}
export function findPath(g, sx, sy, tx, ty, maxNodes = 4000) {
    sx = Math.floor(sx);
    sy = Math.floor(sy);
    tx = Math.floor(tx);
    ty = Math.floor(ty);
    if (!g.ok(tx, ty))
        return null;
    if (sx === tx && sy === ty)
        return [];
    const W = g.w, key = (x, y) => y * W + x;
    const gs = new Map(), came = new Map(), open = [];
    const hfn = (x, y) => { const dx = Math.abs(x - tx), dy = Math.abs(y - ty); return Math.max(dx, dy) + 0.414 * Math.min(dx, dy); };
    gs.set(key(sx, sy), 0);
    open.push([hfn(sx, sy), sx, sy]);
    const closed = new Set();
    let n = 0;
    while (open.length && n++ < maxNodes) {
        let bi = 0;
        for (let i = 1; i < open.length; i++)
            if (open[i][0] < open[bi][0])
                bi = i;
        const [, x, y] = open[bi];
        open[bi] = open[open.length - 1];
        open.pop();
        const k = key(x, y);
        if (closed.has(k))
            continue;
        closed.add(k);
        if (x === tx && y === ty) {
            const out = [];
            let c = k;
            while (c !== key(sx, sy)) {
                out.push([c % W, Math.floor(c / W)]);
                c = came.get(c);
            }
            return out.reverse();
        }
        for (let dx = -1; dx <= 1; dx++)
            for (let dy = -1; dy <= 1; dy++) {
                if (!dx && !dy)
                    continue;
                const nx = x + dx, ny = y + dy;
                if (!g.ok(nx, ny))
                    continue;
                if (dx && dy && (!g.ok(x + dx, y) || !g.ok(x, y + dy)))
                    continue;
                const nk = key(nx, ny), ng = gs.get(k) + (dx && dy ? 1.414 : 1);
                if (ng < (gs.get(nk) ?? Infinity)) {
                    gs.set(nk, ng);
                    came.set(nk, k);
                    open.push([ng + hfn(nx, ny), nx, ny]);
                }
            }
    }
    return null;
}
