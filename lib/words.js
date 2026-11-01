'use strict';
// What the courier reads out of chat. Kept apart from the bot so it can be tested on its own (test/words.test.js).

const NAME = /^[A-Za-z0-9_]{3,16}$/;

// A whisper to us, exactly as 6b6t shows it: " builder_one whispers: 3 boxes obsidian to my chest".
// Public chat on 6b6t always has "»" after the name, so a player typing "builder_one whispers: ..." in public chat never matches.
// Vanilla's "<name> whispers to you: ..." (the test server) is read too.
function whisperOf(line) {
    const t = String(line || '').replace(/^\s+/, '');
    if (!t || t.length > 300 || t.includes('»') || t.includes('<')) return null;
    const m = /^([A-Za-z0-9_]{3,16}) whispers(?: to you)?: (.+)$/.exec(t);
    if (!m) return null;
    return { from: m[1], text: m[2].trim().slice(0, 120) };
}

// An order from a builder: "3 boxes obsidian to my chest" (what the ARGUS sky printer sends), also "3 boxes obsidian", "3 box obby",
// "5 boxes crying_obsidian to my chest", "5 boxes crying obi". -> { n, item } with the item's Minecraft name
const ITEMS = [[/^(?:obsidian|obby|obi)$/i, 'obsidian'], [/^(?:crying[ _]obsidian|crying[ _]obby|crying[ _]obi)$/i, 'crying_obsidian']];
function orderOf(text) {
    const m = /^(\d{1,3}) ?(?:boxes|box|shulkers?|shulks?) (?:of )?([a-z_ ]+?)(?: to my chest)?$/i.exec(String(text || '').trim());
    if (!m) return null;
    const it = ITEMS.find(([re]) => re.test(m[2].trim())), n = Number(m[1]);
    return it && n > 0 ? { n, item: it[1] } : null;
}

// Someone asking to teleport to us: " builder_one wants to teleport to you." / "builder_one has requested to teleport to you."
// Lines about our own requests ("Request sent to", "was accepted", "denied", "expired", "cancelled") are not requests to us.
function tpaRequestFrom(line) {
    const t = String(line || '').replace(/^\s+/, '');
    if (!t || t.includes('»') || /whispers/i.test(t)) return null;
    if (/sent to|was accepted|denied|expired|cancel|cooldown|no pending|not online/i.test(t)) return null;
    const m = /^([A-Za-z0-9_]{3,16}) (?:wants to teleport to you|has requested to teleport to you|has requested that you teleport to them)/i.exec(t);
    return m ? m[1] : null;
}

// "You have to wait 7m 13s to teleport again." -> ms, else null
function cooldownMs(line) {
    const m = /wait\s+(?:(\d+)\s*m(?:in(?:ute)?s?)?\s*)?(?:(\d+)\s*s(?:ec(?:ond)?s?)?)?\s+(?:before you can |to )?teleport/i.exec(String(line || ''));
    if (!m || (!m[1] && !m[2])) return null;
    return ((Number(m[1]) || 0) * 60 + (Number(m[2]) || 0)) * 1000;
}

// A kick that carries 6b6t's anti-bot verify link, or a "wait N minutes" kick: how long to stay offline.
function kickHold(reason) {
    const t = typeof reason === 'string' ? reason : (() => { try { return JSON.stringify(reason); } catch (_) { return String(reason); } })();
    const link = (/https?:\/\/verify\.6b6t\.org\/[^\s"'\\<>]+/i.exec(t) || [])[0] || null;
    if (link) return { why: 'captcha', link, ms: 8 * 60000 };
    const w = /wait\s+(\d+)\s+minutes?\s+before\s+trying\s+again/i.exec(t);
    if (w) return { why: 'wait', ms: Math.min(3 * 3600000, Number(w[1]) * 60000 + 30000) };
    return null;
}

module.exports = { NAME, whisperOf, orderOf, tpaRequestFrom, cooldownMs, kickHold };
