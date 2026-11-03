// 等角投影（菱形 64x32）：tile 座標 ⇄ 螢幕座標
export const TILE_W = 64, TILE_H = 32;
export function toScreen(x, y) { return { sx: (x - y) * (TILE_W / 2), sy: (x + y) * (TILE_H / 2) }; }
export function toTile(sx, sy) {
    const a = sx / (TILE_W / 2), b = sy / (TILE_H / 2);
    return { x: (a + b) / 2, y: (b - a) / 2 };
}
/** 螢幕向量 → 8 方向索引（0=S,1=SW,2=W,3=NW,4=N,5=NE,6=E,7=SE） */
export function dirFromScreen(dx, dy, fallback = 0) {
    if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6)
        return fallback;
    const ang = Math.atan2(-dx, dy); // S=0，順時針
    return ((Math.round(ang / (Math.PI / 4)) % 8) + 8) % 8;
}
