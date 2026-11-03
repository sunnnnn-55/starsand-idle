// 聊天過濾與頻率限制（原創詞表，僅示範常見不雅字）
const BAD = ['幹你', '操你', '去死', '白癡', '智障', '垃圾人', '靠北', 'fuck', 'shit', 'bitch', '低能'];
export const CHAT_MAX = 80;
export function filterChat(text) {
    let t = String(text ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX);
    for (const w of BAD) {
        const re = new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        t = t.replace(re, '＊'.repeat(w.length));
    }
    return t;
}
/** 每人：10 秒內最多 5 則、禁止 30 秒內重複相同內容 */
export class ChatLimiter {
    hist = new Map();
    check(who, text, now = Date.now()) {
        const h = this.hist.get(who) ?? { t: [], last: '', lastT: 0 };
        this.hist.set(who, h);
        h.t = h.t.filter(x => now - x < 10000);
        if (h.t.length >= 5)
            return 'rate';
        if (text === h.last && now - h.lastT < 30000)
            return 'dup';
        h.t.push(now);
        h.last = text;
        h.lastT = now;
        return 'ok';
    }
}
