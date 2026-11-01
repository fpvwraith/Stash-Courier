'use strict';
// elmatadore courier - a standalone 6b6t delivery bot for obsidian.
//
// It lives at its owner's stash. The first time it is brought there (the owner whispers "bed" beside its bed) it walks the
// stash, opens every chest and barrel within stashRadius and writes down where the full obsidian shulker boxes are
// (data/stash-index.json). When one of the builder bots named in config.json whispers "N boxes obsidian to my chest", it
// takes N boxes from the chests the index names, sends /tpa to that builder, puts the boxes into the chest next to the
// builder (the rest is dropped at the builder's feet), and goes back with /kill (it respawns at its bed by the stash).
// The builders never teleport to it and never learn where the stash is. When the chests it knows run dry it walks the stash again.
//
// Nothing here talks to anything but the Minecraft server: no web server, no Discord, no telemetry. Everything it writes
// stays in this folder (logs/, data/). See README.md.
//   node courier.js            (config.json next to this file)
const fs = require('fs'), path = require('path');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const W = require('./lib/words');

const DIR = process.env.COURIER_HOME ? path.resolve(process.env.COURIER_HOME) : __dirname, DATA = path.join(DIR, 'data'), LOGS = path.join(DIR, 'logs');   // COURIER_HOME: another folder for config.json, data/ and logs/ (the tests use it)
fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(LOGS, { recursive: true });
const STOP = path.join(DIR, 'STOP'), PAUSE = path.join(DIR, 'PAUSE'), SPOT = path.join(DATA, 'stash-spot.json'), IDX = path.join(DATA, 'stash-index.json'), STATS = path.join(DATA, 'stats.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); };
const LOGF = path.join(LOGS, 'courier.log');
const log = (m) => { const l = stamp() + ' ' + m; console.log(l); try { if (fs.existsSync(LOGF) && fs.statSync(LOGF).size > 20e6) fs.renameSync(LOGF, LOGF + '.1'); fs.appendFileSync(LOGF, l + '\n'); } catch (_) {} };
const readJ = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } };
const writeJ = (f, v) => { try { fs.writeFileSync(f + '.tmp', JSON.stringify(v)); fs.renameSync(f + '.tmp', f); } catch (e) { log('could not write ' + path.basename(f) + ': ' + e.message); } };

// ---- config (checked once at start; a bad config stops the bot before it connects)
const CFG = (() => {
    const c0 = readJ(path.join(DIR, 'config.json')); if (!c0) { console.log('config.json missing or not valid JSON - copy config.example.json to config.json and fill it in'); process.exit(1); }
    const d = { host: 'mc.6b6t.org', port: 25565, version: '1.21.11', auth: 'microsoft', owner: '', builders: [], items: ['obsidian', 'crying_obsidian'], fullBoxesOnly: true,
        maxBoxesPerOrder: 10, maxBoxesPerHour: 80, maxQueue: 10, orderTtlMin: 30, stashRadius: 32, scanMax: 400, returnBy: 'kill', stashHome: '',
        tpaAsks: 3, tpaWaitSec: 60, handOverRadius: 6, replies: true, tickEnd: true, captchaHoldMin: 8, reindexHours: 6, lobbyMaxSec: 120 };
    const c = Object.assign(d, c0), bad = [];
    if (!c.username) bad.push('"username" (the bot account: its Microsoft e-mail, or its name for an offline account)');
    if (!['microsoft', 'offline'].includes(c.auth)) bad.push('"auth" must be "microsoft" or "offline"');
    c.builders = (Array.isArray(c.builders) ? c.builders : []).map(String).filter((n) => W.NAME.test(n));
    if (!c.builders.length) bad.push('"builders" (the names of the builder bots it may serve)');
    if (c.owner && !W.NAME.test(String(c.owner))) bad.push('"owner" is not a Minecraft name');
    if (!/^(kill|home:[A-Za-z0-9_]{1,16})$/.test(String(c.returnBy))) bad.push('"returnBy" must be "kill" or "home:<name>"');
    if (c.stashHome && !/^[A-Za-z0-9_]{1,16}$/.test(String(c.stashHome))) bad.push('"stashHome" must be a home name');
    if (bad.length) { console.log('config.json: ' + bad.join('; ')); process.exit(1); }
    c.items = (Array.isArray(c.items) ? c.items : c.item ? [c.item] : []).map(String).filter((x) => /^[a-z_]{3,40}$/.test(x));
    if (!c.items.length) { console.log('config.json: "items" must list what it may carry, e.g. ["obsidian", "crying_obsidian"]'); process.exit(1); }
    c.maxBoxesPerOrder = Math.max(1, Math.min(27, Number(c.maxBoxesPerOrder) || 10));
    c.stashRadius = Math.max(4, Math.min(64, Number(c.stashRadius) || 32));
    return c;
})();
const isBuilder = (n) => CFG.builders.some((b) => b.toLowerCase() === String(n).toLowerCase());
const isOwner = (n) => !!CFG.owner && String(n).toLowerCase() === String(CFG.owner).toLowerCase();

// ---- state that lives across reconnects
const queue = [];            // { from, n, item, at }
const emptyUntil = {};       // item -> time: no boxes of it in the stash, the next look is then (emptyper-20261102: one empty item held up every order)
const sent = [];             // { at, n } boxes handed over, for the hourly cap
const stats = Object.assign({ delivered: 0, trips: 0, failedTrips: 0, lost: 0 }, readJ(STATS) || {});
const addStat = (k, n) => { stats[k] = (stats[k] || 0) + (n === undefined ? 1 : n); writeJ(STATS, stats); };
let bot = null, B = null, busy = false, trip = false, blockedUntil = 0, emptyToldAt = 0, quickFails = 0, lastIdleIndex = Date.now();
const readSpot = () => { const s = readJ(SPOT); return s && Number.isFinite(s.x) ? s : null; };
const readIndex = () => { const x = readJ(IDX), s = readSpot(); return x && s && Array.isArray(x.containers) && x.spot && x.spot.x === s.x && x.spot.y === s.y && x.spot.z === s.z ? x : null; };
const boxesLastHour = () => { const t = Date.now() - 3600000; while (sent.length && sent[0].at < t) sent.shift(); return sent.reduce((a, s) => a + s.n, 0); };

// every step of a trip checks the bot is still the one it started with: after a disconnect the old trip stops at its next step
class Gone extends Error {}
const alive = () => !!(bot && B === bot && bot.entity);
async function nap(ms) { await sleep(ms); if (!alive()) throw new Gone('disconnected'); }
const within = (p, ms, what) => Promise.race([p, sleep(ms).then(() => { throw new Error(what + ' took longer than ' + Math.round(ms / 1000) + ' s'); })]);
const say = (m) => { try { if (bot) bot.chat(m); } catch (_) {} };
const tell = (to, m) => { if (CFG.replies && to) say('/msg ' + to + ' ' + String(m).slice(0, 200)); };

function connect() {
    log('connecting to ' + CFG.host + ' as ' + (CFG.auth === 'microsoft' ? 'the Microsoft account in config.json' : CFG.username));
    let b;
    try {
        b = mineflayer.createBot({
            host: CFG.host, port: CFG.port, version: CFG.version, username: CFG.username, auth: CFG.auth,
            profilesFolder: path.join(DATA, 'auth'), viewDistance: 'normal', checkTimeoutInterval: 60000,
            onMsaCode: (d) => log('SIGN IN: open ' + d.verification_uri + ' and enter the code ' + d.user_code + ' (once; the sign-in is kept in data/auth)'),
        });
    } catch (e) { log('could not start a connection: ' + e.message + ' - again in 60 s'); setTimeout(connect, 60000); return; }
    bot = b; b.loadPlugin(pathfinder);
    let hold = null, loggedInAt = 0, onMain = false, lobbySince = 0, queued = false, outageAt = 0, inPortal = false, inPortalAt = 0, portalTries = 0, sentLogin = false, ended = false;
    const lastFrom = {};

    // a real 1.21.2+ client sends tick_end after every client tick; 6b6t kicks movement without it
    if (CFG.tickEnd) { let last = 0; const send = () => { try { if (b._client.state === 'play') b._client.write('tick_end', {}); } catch (_) {} };
        b.on('physicsTick', () => { last = Date.now(); send(); }); const iv = setInterval(() => { if (Date.now() - last > 75) send(); }, 50); b.once('end', () => clearInterval(iv)); }

    b.on('login', () => { loggedInAt = Date.now(); log('logged in'); });
    b.on('kicked', (r) => { log('KICKED: ' + (typeof r === 'string' ? r : JSON.stringify(r)).slice(0, 300)); hold = W.kickHold(r);
        if (hold && hold.why === 'captcha') { hold.ms = CFG.captchaHoldMin * 60000; log('CAPTCHA: open this link in a browser and solve it - the bot stays offline ' + CFG.captchaHoldMin + ' min so it stays valid: ' + hold.link); } });
    b.on('error', (e) => log('error: ' + (e && e.message)));
    b.on('end', (r) => {
        if (ended) return; ended = true;
        log('disconnected: ' + r); if (bot === b) bot = null; busy = false; trip = false;
        const stayedMin = loggedInAt ? (Date.now() - loggedInAt) / 60000 : 0; quickFails = stayedMin >= 5 ? 0 : quickFails + 1;
        const ms = hold ? hold.ms : Math.min(10 * 60000, 30000 * Math.pow(2, Math.max(0, quickFails - 1)));
        if (fs.existsSync(STOP)) { log('STOP file present - not reconnecting'); process.exit(0); }
        log('reconnecting in ' + Math.round(ms / 1000) + ' s'); setTimeout(connect, ms);
    });
    b.on('death', () => log('died'));

    const isOnMain = () => !!(b.game && b.game.gameMode === 'survival');
    b.on('messagestr', (m) => { try {
        const t = String(m);
        if (!isOnMain()) {
            if (/queue|position/i.test(t)) { if (!queued) log('lobby: ' + t.trim().slice(0, 120)); queued = true; }
            if (/target server is offline|starting up|come back online|unable to connect you|sent you back to the backup|sent to the backup/i.test(t)) { if (!outageAt) log('lobby: the main server is down - waiting'); outageAt = Date.now(); }
            if (CFG.auth === 'offline' && !sentLogin && /\/login/i.test(t) && process.env.COURIER_PASSWORD) { sentLogin = true; setTimeout(() => { try { b.chat('/login ' + process.env.COURIER_PASSWORD); } catch (_) {} }, 1000); log('sent /login'); }
        }
        const w = W.whisperOf(t);
        if (w) { if (Date.now() - (lastFrom[w.from] || 0) < 2000) return; lastFrom[w.from] = Date.now(); onWhisper(w); return; }
        const tp = W.tpaRequestFrom(t);
        if (tp) log('teleport request from ' + tp + ' - ignored (it never accepts a teleport request)');
    } catch (e) { log('chat: ' + e.message); } });

    function onWhisper(w) {
        if (isOwner(w.from)) return ownerCommand(w.text);
        if (!isBuilder(w.from)) { log('whisper from ' + w.from + ' (not a builder) - ignored'); return; }
        const o = W.orderOf(w.text);
        if (!o) { log('whisper from ' + w.from + ' not understood: ' + w.text.slice(0, 60)); return; }
        if (!CFG.items.includes(o.item)) { log('order from ' + w.from + ' for ' + o.item + ' refused: not in "items"'); return; }
        const n = Math.min(o.n, CFG.maxBoxesPerOrder);
        const had = queue.find((q) => q.from.toLowerCase() === w.from.toLowerCase() && q.item === o.item);
        if (had) { had.at = Date.now(); log('order from ' + w.from + ' already on the list'); return; }
        if (queue.length >= CFG.maxQueue) { log('order from ' + w.from + ' refused: the list is full'); tell(w.from, 'busy - ask again later'); return; }
        queue.push({ from: w.from, n, item: o.item, at: Date.now() }); log('order: ' + n + ' boxes ' + o.item + ' for ' + w.from + ' (' + queue.length + ' on the list)');
        tell(w.from, 'ok: ' + n + ' boxes ' + o.item + ' - on the list (' + queue.length + ')');
    }
    function ownerCommand(text) {
        const t = text.trim().toLowerCase(), ix = readIndex();
        if (t === 'status') return tell(CFG.owner, 'list ' + queue.length + ', ' + boxesLastHour() + ' boxes last hour, ' + stats.delivered + ' delivered, ' + stats.lost + ' lost' + (ix ? ', stash: ' + CFG.items.map((it) => ixBoxes(it) + ' ' + it).join(', ') + ' boxes known' : ', no stash index') + (fs.existsSync(PAUSE) ? ', PAUSED' : '') + (trip ? ', on a trip' : '') + (readSpot() ? '' : ', NO stash spot (whisper "bed" at the stash)'));
        if (t === 'pause') { fs.writeFileSync(PAUSE, 'paused by the owner ' + stamp()); log('paused by the owner'); return tell(CFG.owner, 'paused'); }
        if (t === 'resume') { try { fs.unlinkSync(PAUSE); } catch (_) {} blockedUntil = 0; for (const k of Object.keys(emptyUntil)) delete emptyUntil[k]; log('resumed by the owner'); return tell(CFG.owner, 'resumed'); }
        if (t === 'bed') { if (trip) return tell(CFG.owner, 'on a trip - ask again when it is done'); return setBed().then((r) => tell(CFG.owner, r)).catch((e) => tell(CFG.owner, 'bed: ' + e.message)); }
        if (t === 'index') { if (trip) return tell(CFG.owner, 'on a trip - ask again when it is done'); if (!readSpot()) return tell(CFG.owner, 'no stash spot yet - whisper "bed" first'); wantIndex = 'the owner asked'; return tell(CFG.owner, 'indexing the stash next'); }
        if (t === 'come') { if (trip) return tell(CFG.owner, 'on a trip - ask again when it is done'); say('/tpa ' + CFG.owner); log('/tpa ' + CFG.owner + ' (the owner asked it to come)'); return; }
        log('owner whisper not understood: ' + text.slice(0, 60));
    }

    // ---- the lobby: walk into the portal, wait there until the server moves us; log off if stuck
    const tick = setInterval(() => { try {
        if (b !== bot || !b.entity) return;
        if (!isOnMain()) {
            onMain = false; if (!lobbySince) lobbySince = Date.now();
            if (!queued && !(outageAt && Date.now() - outageAt < 600000) && Date.now() - lobbySince > CFG.lobbyMaxSec * 1000) { log('still in the lobby after ' + CFG.lobbyMaxSec + ' s - reconnecting'); b.quit('stuck in the lobby'); return; }
            const p = b.entity.position, feet = b.blockAt(p), head = b.blockAt(p.offset(0, 1, 0));
            if (inPortal && Date.now() - inPortalAt > 10000) { inPortal = false; b.physicsEnabled = true; log('the portal did not take us - walking further in'); }
            if ((feet && feet.name === 'nether_portal') || (head && head.name === 'nether_portal')) {
                if (!inPortal) { if (portalTries++ > 0) { b.setControlState('forward', true); b.setControlState('sprint', true); setTimeout(() => { if (isOnMain() || !inPortal) return; b.clearControlStates(); b.physicsEnabled = false; }, 700); } else { b.clearControlStates(); b.physicsEnabled = false; } inPortal = true; inPortalAt = Date.now(); log('in the lobby portal'); }
            } else if (!inPortal && (CFG.auth === 'microsoft' || sentLogin)) { b.setControlState('forward', true); b.setControlState('sprint', true); b.setControlState('jump', true); }
            return;
        }
        if (!onMain) { onMain = true; lobbySince = 0; queued = false; portalTries = 0; outageAt = 0; if (inPortal) { inPortal = false; b.physicsEnabled = true; } b.clearControlStates(); log('on the main server'); setTimeout(() => work(b).catch((e) => { if (!(e instanceof Gone)) log('work: ' + e.message); }), 4000); }
    } catch (e) { log('tick: ' + e.message); } }, 1000);
    b.once('end', () => clearInterval(tick));
}

// ---------------------------------------------------------------- the work loop
let wantIndex = null;
async function work(b) {
    if (busy || bot !== b) return; busy = true; B = b;
    try {
        await nap(2000);
        if (!readSpot()) log('no stash spot yet: whisper it "come" from the owner account at the stash, accept its /tpa, stand it beside its bed and whisper "bed"');
        else await settle('after joining');
        for (;;) {
            await nap(1000);
            if (fs.existsSync(STOP)) { log('STOP file present - logging off'); b.quit('stopped'); return; }
            const t = Date.now(); for (let i = queue.length - 1; i >= 0; i--) if (t - queue[i].at > CFG.orderTtlMin * 60000) { log('order from ' + queue[i].from + ' dropped (no new ask for ' + CFG.orderTtlMin + ' min)'); queue.splice(i, 1); }
            if (!readSpot()) continue;
            if (wantIndex && atStash()) { const why = wantIndex; wantIndex = null; await indexStash(why); continue; }
            if (fs.existsSync(PAUSE)) continue;
            if (!queue.length) { if (atStash() && Date.now() - lastIdleIndex > CFG.reindexHours * 3600000) { lastIdleIndex = Date.now(); await indexStash('a routine look while idle'); } continue; }
            if (Date.now() < blockedUntil || boxesLastHour() >= CFG.maxBoxesPerHour) continue;
            const o = queue.find((q) => !(Date.now() < (emptyUntil[q.item] || 0))); if (!o) continue;   // the first order whose item the stash has
            let r = 'done'; trip = true;
            try { r = await serve(o); } catch (e) { if (e instanceof Gone) throw e; log('trip for ' + o.from + ' stopped: ' + e.message); addStat('failedTrips'); r = 'failed'; } finally { trip = false; }
            const i = queue.indexOf(o); if (i >= 0) { queue.splice(i, 1); if (r === 'later') queue.push(o); }
            if (!atStash() && !fs.existsSync(PAUSE)) await settle('after a trip');   // paused because it cannot get home: no more /kills until the owner fixes it
        }
    } finally { if (B === b) { busy = false; B = null; } }
}

// ---------------------------------------------------------------- helpers
const pos = () => bot.entity.position;
const V = (a) => new Vec3(a[0], a[1], a[2]);
const spotVec = () => { const s = readSpot(); return s ? new Vec3(s.x, s.y, s.z) : pos(); };
function atStash() { const s = readSpot(); return !!(s && alive() && Math.hypot(pos().x - s.x, pos().z - s.z) <= CFG.stashRadius + 4 && Math.abs(pos().y - s.y) <= 16); }
// the item a shulker box holds, when it holds only one of the "items" (and is full, if fullBoxesOnly); its contents come with
// the item's "container" component. null for anything else.
function boxItem(it) {
    if (!it || !/shulker_box$/.test(it.name) || it.count !== 1) return null;
    const cc = (it.components || []).find((x) => x && x.type === 'container'); if (!cc) return null;
    const d = cc.data, inner = Array.isArray(d) ? d : (d && (d.contents || d.items)) || [];
    let id = null, n = 0; for (const x of inner) { const q = x && (x.item || x), i = q && q.itemId, k = q && (q.itemCount || q.count); if (i === undefined || i === null || !k) continue; if (id !== null && i !== id) return null; id = i; n += k; }
    const r = id === null ? null : bot.registry.items[id]; if (!r || !CFG.items.includes(r.name)) return null;
    return n > 0 && (!CFG.fullBoxesOnly || n >= 27 * (r.stackSize || 64)) ? r.name : null;
}
const isBox = (it, item) => { const b = boxItem(it); return !!b && (!item || b === item); };
const carried = (item) => bot.inventory.items().filter((it) => isBox(it, item));
const playerNear = (name, r) => { const e = Object.values(bot.entities).find((o) => o && o.type === 'player' && o.username && o.username.toLowerCase() === String(name).toLowerCase()); return e && e.position.distanceTo(pos()) <= r ? e : null; };
const builderNear = (r) => { for (const n of CFG.builders) { const e = playerNear(n, r); if (e) return e; } return null; };
const eye = () => pos().offset(0, 1.62, 0);
const CW = { north: 'east', east: 'south', south: 'west', west: 'north' }, CCW = { north: 'west', west: 'south', south: 'east', east: 'north' }, DIRS = { east: [1, 0], west: [-1, 0], south: [0, 1], north: [0, -1] };
const containerIds = () => ['chest', 'barrel'].map((n) => bot.registry.blocksByName[n] && bot.registry.blocksByName[n].id).filter((x) => x != null);   // trapped chests are never touched
// no corner cutting: the pathfinder takes a diagonal step when either side is clear, and the bot's body then catches on the
// corner of the other side - "stuck", the same diagonal again, forever (the test bot spent 10 min at the end of a wall). A
// diagonal step here needs both sides clear at foot and head height.
class Moves extends Movements {
    getMoveDiagonal(node, dir, nb) { for (const [dx, dz] of [[dir.x, 0], [0, dir.z]]) for (const dy of [0, 1]) if (this.getBlock(node, dx, dy, dz).physical) return; return super.getMoveDiagonal(node, dir, nb); }
}
function movements() { const mv = new Moves(bot); mv.canDig = false; mv.allow1by1towers = false; mv.scafoldingBlocks = []; mv.allowParkour = false; mv.canOpenDoors = true; return mv; }
// a walk that still gets stuck is tried once more after a step aside and a jump; failures are logged (once a minute at most)
let walkFailSaid = 0;
async function walkTo(goal, ms) {
    for (let k = 1; k <= 2; k++) {
        const p0 = pos().clone();
        try { bot.pathfinder.setMovements(movements()); await within(bot.pathfinder.goto(goal), Math.min(ms, 15000 * k), 'the walk'); return true; }
        catch (e) {
            try { bot.pathfinder.setGoal(null); } catch (_) {} try { bot.clearControlStates(); } catch (_) {} if (!alive()) throw new Gone('disconnected');
            if (Date.now() - walkFailSaid > 60000) { walkFailSaid = Date.now(); log('a walk failed (' + e.message + '; moved ' + pos().distanceTo(p0).toFixed(1) + ' blocks)' + (k === 1 ? ' - stepping aside and trying again' : '')); }
            if (k === 1) { try { await bot.look(bot.entity.yaw + Math.PI * (0.5 + Math.random()), 0, true); bot.setControlState('forward', true); bot.setControlState('jump', true); await nap(600); } finally { bot.clearControlStates(); } await nap(300); }
        }
    }
    return false;
}
async function closeAny() { try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow); } catch (_) {} }
// open the container at p (a block position): walk up to it if needed; null when it is gone, not reached or does not open
let openFails = 0;
async function openAt(p) {
    await closeAny();
    const blk = bot.blockAt(p); if (!blk || !containerIds().includes(blk.type)) return { gone: true };
    const reach = () => p.offset(0.5, 0.5, 0.5).distanceTo(eye());
    if (reach() > 4.2) { if (!(await walkTo(new goals.GoalGetToBlock(p.x, p.y, p.z), 25000))) await walkTo(new goals.GoalNear(p.x, p.y, p.z, 3), 15000); }
    if (reach() > 4.5) return { far: true };
    try { const w = await within(bot.openContainer(bot.blockAt(p)), 8000, 'opening a container'); await nap(250); openFails = 0; return { w }; }
    catch (e) {
        if (!alive()) throw new Gone('disconnected'); await closeAny();
        // openfails-20261102: in the test, after the bed was fixed every container open timed out for 8 min (54 of 77) until its next
        // death; the cause was not found. Three in a row = reconnect, which starts it clean; an index that was cut short runs again.
        openFails++; log('a container did not open (' + e.message + '; ' + blk.name + ' ' + reach().toFixed(1) + ' blocks from its eyes; ' + openFails + ' in a row)');
        if (openFails >= 3) { openFails = 0; log('3 containers in a row did not open - reconnecting to start clean'); try { bot.quit('containers do not open'); } catch (_) {} throw new Gone('reconnecting'); }
        return { stuck: true };
    }
}
// shift-click one slot, true when it really moved
async function shift(win, slot) { if (!win.slots[slot]) return false; try { await within(bot.clickWindow(slot, 0, 1), 5000, 'a click'); } catch (_) { return false; } for (let k = 0; k < 12; k++) { await nap(80); if (!win.slots[slot]) return true; } return false; }
const freeIn = (w) => { let n = 0; for (let i = 0; i < w.inventoryStart; i++) if (!w.slots[i]) n++; return n; };
const fullIn = (w) => { const r = {}; for (let i = 0; i < w.inventoryStart; i++) { const b = boxItem(w.slots[i]); if (b) r[b] = (r[b] || 0) + 1; } return r; };
const sumOf = (o) => Object.values(o || {}).reduce((a, k) => a + k, 0);

// ---------------------------------------------------------------- the stash index
async function indexStash(why) {
    const s = spotVec(), ids = containerIds(), t0 = Date.now();
    log('indexing the stash (' + why + '): every chest and barrel within ' + CFG.stashRadius + ' blocks of the stash spot');
    wantIndex = why;   // until it is finished: an index cut short by a disconnect runs again after it
    const found = bot.findBlocks({ matching: ids, maxDistance: CFG.stashRadius + 8, count: CFG.scanMax * 2, point: s }).filter((p) => p.distanceTo(s) <= CFG.stashRadius);
    const seen = new Set(), list = [];
    for (const p of found) {
        const k = p.toString(); if (seen.has(k)) continue; seen.add(k);
        const blk = bot.blockAt(p); if (!blk) continue; let p2 = null;
        if (blk.name === 'chest') { let pr = {}; try { pr = blk.getProperties(); } catch (_) {} const f = pr.type === 'left' ? CW[pr.facing] : pr.type === 'right' ? CCW[pr.facing] : null;
            if (f) { const q = p.offset(DIRS[f][0], 0, DIRS[f][1]), qb = bot.blockAt(q); if (qb && qb.name === 'chest') { p2 = q; seen.add(q.toString()); } } }
        list.push({ p: [p.x, p.y, p.z], p2: p2 ? [p2.x, p2.y, p2.z] : null, kind: blk.name, boxes: {}, free: 0, bad: 0 });
        if (list.length >= CFG.scanMax) break;
    }
    // visit them nearest-first from where it stands
    const route = []; let here = pos().clone(); const left = list.slice();
    while (left.length) { left.sort((u, v) => V(u.p).distanceTo(here) - V(v.p).distanceTo(here)); const c = left.shift(); route.push(c); here = V(c.p); }
    let opened = 0, unreached = 0; const boxes = {};
    let done = 0;
    for (const c of route) {
        if (++done % 20 === 0) log('indexing: ' + done + ' of ' + route.length + ' containers looked at');
        const o = await openAt(V(c.p));
        if (!o.w) { c.bad = 1; if (!o.gone) unreached++; continue; }
        try { c.boxes = fullIn(o.w); c.free = freeIn(o.w); c.size = o.w.inventoryStart; opened++; for (const [k, v] of Object.entries(c.boxes)) boxes[k] = (boxes[k] || 0) + v; } finally { await closeAny(); await nap(200); }
    }
    const sp = readSpot(), ix = { at: stamp(), atMs: Date.now(), spot: { x: sp.x, y: sp.y, z: sp.z }, containers: route.filter((c) => !c.bad) };
    for (const c of route) if (c.bad) ix.containers.push(c);
    writeJ(IDX, ix); lastIdleIndex = Date.now(); wantIndex = null;
    for (const [k, v] of Object.entries(boxes)) if (v > 0 && emptyUntil[k]) { delete emptyUntil[k]; log('found ' + v + ' ' + k + ' boxes again - its orders go on'); }
    const msg = 'stash indexed in ' + Math.round((Date.now() - t0) / 1000) + ' s: ' + list.length + ' containers, ' + opened + ' opened, full boxes: ' + CFG.items.map((it) => (boxes[it] || 0) + ' ' + it).join(', ') + (unreached ? ', ' + unreached + ' could not be reached or opened' : '');
    log(msg); if (CFG.owner) tell(CFG.owner, msg);
    if (alive() && !atStash()) await settle('the index walk went too far');
    return boxes;
}
const ixBoxes = (item) => { const ix = readIndex(); return ix ? ix.containers.reduce((a, c) => a + (c.bad >= 3 || !c.boxes ? 0 : item ? (c.boxes[item] || 0) : sumOf(c.boxes)), 0) : 0; };
function ixUpdate(c, w) { const ix = readIndex(); if (!ix) return; const r = ix.containers.find((x) => x.p.join() === c.p.join()); if (!r) return; if (w) { r.boxes = fullIn(w); r.free = freeIn(w); r.bad = 0; } else r.bad = (r.bad || 0) + 1; writeJ(IDX, ix); }
const byDistance = (cs) => cs.slice().sort((u, v) => V(u.p).distanceTo(pos()) - V(v.p).distanceTo(pos()));

async function takeBoxes(n, item) {
    const ix = readIndex(); if (!ix) return carried(item).length;
    // counted here, not from the pockets: while a chest is open the pockets' count lags behind (the test took 12 boxes for 10)
    let have = carried(item).length;
    for (const c of byDistance(ix.containers.filter((x) => x.boxes && x.boxes[item] > 0 && (x.bad || 0) < 3))) {
        if (have >= n || bot.inventory.emptySlotCount() < 1) break;
        const o = await openAt(V(c.p)); if (!o.w) { ixUpdate(c, null); continue; }
        try { for (let s = 0; s < o.w.inventoryStart && have < n; s++) { if (isBox(o.w.slots[s], item) && await shift(o.w, s)) have++; } ixUpdate(c, o.w); } finally { await closeAny(); await nap(250); }
    }
    await nap(300);
    return carried(item).length;
}
// the bot's own things (anything that is not a full box of the item) stay at the stash, so a /kill never drops them at a build site
async function leaveOwnThings(item) {   // boxes of another item count as its own things too: only this trip's item leaves the stash
    const own = () => bot.inventory.items().filter((it) => !isBox(it, item));
    if (!own().length) return true;
    const ix = readIndex(); if (!ix) return false;
    let tries = 0;
    for (const c of byDistance(ix.containers.filter((x) => x.free > 0 && (x.bad || 0) < 3))) {
        if (!own().length || ++tries > 8) break;
        const o = await openAt(V(c.p)); if (!o.w) { ixUpdate(c, null); continue; }
        try { for (let s = o.w.inventoryStart; s < o.w.slots.length; s++) { const it = o.w.slots[s]; if (!it || isBox(it, item)) continue; if (!freeIn(o.w)) break; await shift(o.w, s); } ixUpdate(c, o.w); } finally { await closeAny(); await nap(250); }
    }
    const left = own(); if (left.length) { log('its own things could not all be put away at the stash (' + left.slice(0, 6).map((i) => i.count + ' ' + i.name).join(', ') + ') - no trip until there is room'); return false; }
    log('its own things are left in a chest at the stash for the trip'); return true;
}
async function putBack(item) {   // a trip that did not happen: the boxes go back into the stash
    const ix = readIndex(); if (!ix) return;
    let tries = 0;
    for (const c of byDistance(ix.containers.filter((x) => x.free > 0 && (x.bad || 0) < 3))) {
        if (!carried(item).length || ++tries > 8) break;
        const o = await openAt(V(c.p)); if (!o.w) { ixUpdate(c, null); continue; }
        try { for (let s = o.w.inventoryStart; s < o.w.slots.length; s++) { if (isBox(o.w.slots[s], item) && freeIn(o.w)) await shift(o.w, s); } ixUpdate(c, o.w); } finally { await closeAny(); await nap(250); }
    }
    log(carried(item).length ? carried(item).length + ' boxes stay on the bot (no room to put them back) - the next trip takes them' : 'the boxes are back in the stash');
}

// ---------------------------------------------------------------- the trip
async function tpaTo(name) {
    let cd = 0, refused = ''; const onMsg = (m) => { const t = String(m), ms = W.cooldownMs(t); if (ms) cd = ms; if (/not online|player not found|no player|is offline|cannot teleport|has teleport(ation)? disabled|denied/i.test(t) && !/»|whispers/.test(t)) refused = t.slice(0, 100); };
    bot.on('messagestr', onMsg);
    try {
        let waits = 0;
        for (let ask = 1; ask <= CFG.tpaAsks; ask++) {
            const p0 = pos().clone(); cd = 0; refused = ''; say('/tpa ' + name); log('/tpa ' + name + ' sent (' + ask + ' of ' + CFG.tpaAsks + ')');
            const t0 = Date.now();
            while (Date.now() - t0 < CFG.tpaWaitSec * 1000) {
                await nap(500);
                if (cd || refused) break;
                if (pos().distanceTo(p0) > 30) {   // it moved: is the builder here?
                    for (let k = 0; k < 12; k++) { const e = playerNear(name, 8); if (e) return e; await nap(500); }
                    log('teleported, but ' + name + ' is not here'); return null;
                }
            }
            if (cd && waits < 3) { waits++; log('teleport cooldown - waiting ' + Math.round(cd / 1000) + ' s'); await nap(Math.min(cd, 15 * 60000) + 3000); ask--; continue; }
            if (refused) { log('the server said: ' + refused); if (/not online|not found|no player|offline/i.test(refused)) return null; }
        }
        return null;
    } finally { try { bot.removeListener('messagestr', onMsg); } catch (_) {} }
}
async function handOver(name, e0, item) {
    await nap(900); let inChest = 0, thrown = 0;
    const builder = () => playerNear(name, 16) || e0;
    const at = builder().position.clone();
    const chests = bot.findBlocks({ matching: containerIds(), maxDistance: CFG.handOverRadius + 2, count: 12, point: at }).filter((p) => p.distanceTo(at) <= CFG.handOverRadius).sort((u, v) => u.distanceTo(at) - v.distanceTo(at));
    for (const p of chests) {
        if (!carried(item).length) break;
        const o = await openAt(p); if (!o.w) continue;
        try { for (let s = o.w.inventoryStart; s < o.w.slots.length; s++) { if (isBox(o.w.slots[s], item) && freeIn(o.w) && await shift(o.w, s)) inChest++; } } finally { await closeAny(); await nap(250); }
    }
    // what did not fit: dropped straight down at the builder's feet (after the /tpa both stand on the same spot), then the courier
    // walks off at once, inside the 2 s before it could pick its own boxes up again, and waits until the builder has them all
    const onGround = () => Object.values(bot.entities).filter((o) => o && o.name === 'item' && o.position.distanceTo(builder().position) <= 10 && (() => { try { return /shulker_box$/.test(o.getDroppedItem().name); } catch (_) { return false; } })()).length;
    for (let round = 1; round <= 3 && carried(item).length; round++) {
        if (builder().position.distanceTo(pos()) > 2.5) await walkTo(new goals.GoalNear(builder().position.x, builder().position.y, builder().position.z, 1), 8000);
        const before = carried(item).length;
        try { await bot.look(bot.entity.yaw, -Math.PI / 2, true); } catch (_) {}
        for (const it of carried(item)) { try { await within(bot.tossStack(it), 3000, 'a throw'); } catch (_) {} await nap(60); }
        const b = builder().position; const away = pos().minus(b); const yaw = Math.atan2(-(away.x || 0.01), -(away.z || 0.01));
        try { await bot.look(Math.hypot(away.x, away.z) > 0.2 ? yaw : bot.entity.yaw + Math.PI, 0, true); bot.setControlState('forward', true); bot.setControlState('sprint', true); await nap(900); } finally { bot.clearControlStates(); }
        thrown += before - carried(item).length;
        const t0 = Date.now(); while (Date.now() - t0 < 12000 && onGround() > 0) await nap(500);
        if (carried(item).length) log(carried(item).length + ' boxes came back onto the courier - throwing again');
    }
    const left = onGround();
    log('at ' + name + ': ' + inChest + ' boxes into the chest, ' + thrown + ' thrown to it' + (left ? ' (' + left + ' still on the ground near it)' : ''));
    return inChest + thrown;
}
// back to the stash: /kill (respawn at the bed) or /home; with boxes on it and a builder beside it, they are handed over first
async function settle(why) {
    if (atStash()) { if (!readIndex()) await indexStash('first time at the stash'); return true; }
    // waitbuilder-20261102: after a server restart it can rejoin at a builder's spot before the builder does (the soak: 3 boxes
    // dropped by the /kill, picked up later only by luck) - with boxes on it, it waits up to 3 min for a builder to appear
    if (carried().length && !builderNear(8)) { log('away from the stash with ' + carried().length + ' boxes and no builder here - waiting up to 3 min for one to come back'); const t0 = Date.now(); while (Date.now() - t0 < 180000 && !builderNear(8)) await nap(2000); }
    if (carried().length) { const e = builderNear(8); if (e) { log('away from the stash with ' + carried().length + ' boxes and ' + e.username + ' beside it - handing them over'); const k = await handOver(e.username, e); sent.push({ at: Date.now(), n: k }); addStat('delivered', k); } }
    return goBack(why);
}
async function goBack(why) {
    if (!readSpot()) return false;
    for (let k = 1; k <= 3; k++) {
        const n = carried().length, home = n && CFG.stashHome ? CFG.stashHome : CFG.returnBy.startsWith('home:') ? CFG.returnBy.slice(5) : '';
        if (n && !home) { log('LOST: ' + n + ' boxes on the bot away from the stash and no builder beside it - /kill drops them here (set "stashHome" to keep them)'); addStat('lost', n); }
        let noBed = false; const onMsg = (m) => { if (/no home bed|respawn anchor|obstructed|bed was missing|could not find/i.test(String(m))) noBed = true; }; bot.on('messagestr', onMsg);
        try {
            say(home ? '/home ' + home : '/kill'); log('going back to the stash (' + why + '): ' + (home ? '/home ' + home : '/kill'));
            const t0 = Date.now(); while (Date.now() - t0 < 45000) { await nap(1000); if (atStash() && bot.health > 0) { log('back at the stash'); await nap(1500); return true; } if (noBed && Date.now() - t0 > 5000) break; }
        } finally { try { bot.removeListener('messagestr', onMsg); } catch (_) {} }
        if (noBed) { log('the server says the bed is missing or blocked'); break; }
    }
    log('NOT BACK AT THE STASH - paused. Fix the bed, bring it back ("come", then "bed" beside the bed) and whisper "resume"');
    fs.writeFileSync(PAUSE, 'not back at the stash ' + stamp()); tell(CFG.owner, 'I am not back at the stash (bed missing?) - paused. Whisper "come", then "bed" beside my bed, then "resume"');
    return false;
}
async function setBed() {
    const ids = Object.values(bot.registry.blocksByName).filter((x) => /_bed$/.test(x.name)).map((x) => x.id);
    const bed = bot.findBlock({ matching: ids, maxDistance: 4 }); if (!bed) return 'no bed within 4 blocks';
    let said = ''; const on = (m) => { if (/respawn|spawn point/i.test(String(m))) said = String(m); }; bot.on('messagestr', on);
    try { await within(bot.activateBlock(bed), 5000, 'the bed'); await sleep(1500); if (bot.isSleeping) { try { await bot.wake(); } catch (_) {} } }
    catch (e) { return 'the bed did not work: ' + e.message; } finally { bot.removeListener('messagestr', on); }
    writeJ(SPOT, { x: Math.round(pos().x), y: Math.round(pos().y), z: Math.round(pos().z), at: stamp() });
    log('stash spot saved (data/stash-spot.json); bed: ' + (said || 'the server said nothing - the first trip shows whether the respawn works'));
    wantIndex = 'first time at the stash'; try { fs.unlinkSync(PAUSE); } catch (_) {}
    return 'stash spot saved' + (said ? ', respawn point set' : ' (the server said nothing about the respawn point)') + ' - indexing the stash now';
}

async function serve(o) {
    const n = Math.min(o.n, CFG.maxBoxesPerOrder, Math.max(0, CFG.maxBoxesPerHour - boxesLastHour()));
    if (!n) return 'later';
    if (!atStash() && !(await settle('before a trip'))) throw new Error('not at the stash');
    if (!readIndex()) await indexStash('no index yet');
    const item = o.item;
    if (!(await leaveOwnThings(item))) { tell(CFG.owner, 'my own things fill my pockets and no stash chest has room for them - no trips until there is'); blockedUntil = Date.now() + 5 * 60000; return 'later'; }
    let got = await takeBoxes(n, item);
    if (got < n && ixBoxes(item) === 0 && Date.now() - lastIdleIndex > 10 * 60000) { await indexStash('the chests it knows have no ' + item + ' boxes left'); got = await takeBoxes(n, item); }
    if (!got) {
        log('no ' + (CFG.fullBoxesOnly ? 'full ' : '') + item + ' boxes in the stash - looking again in 5 min'); emptyUntil[item] = Date.now() + 5 * 60000; wantIndex = 'looking for refilled chests';
        if (Date.now() - emptyToldAt > 3600000) { emptyToldAt = Date.now(); tell(CFG.owner, 'the stash has no full ' + item + ' boxes left - refill and I carry on by myself'); }
        return 'later';
    }
    log('trip for ' + o.from + ': carrying ' + got + ' boxes (' + (got * 27 * 64).toLocaleString('en-US') + ' ' + item + ')'); addStat('trips');
    const e = await tpaTo(o.from);
    if (!e) { log(o.from + ' did not take the teleport'); addStat('failedTrips'); if (atStash()) await putBack(item); return 'failed'; }
    const k = await handOver(o.from, e, item); sent.push({ at: Date.now(), n: k }); addStat('delivered', k);
    tell(o.from, 'done: ' + k + ' boxes ' + item);
    await nap(1500);
    await settle('trip done');
    return 'done';
}

process.on('SIGINT', () => { log('stopping (Ctrl+C)'); try { if (bot) bot.quit('stopped'); } catch (_) {} setTimeout(() => process.exit(0), 1500); });
process.on('unhandledRejection', (e) => { if (!(e instanceof Gone)) log('unhandled: ' + (e && e.message)); });
process.on('uncaughtException', (e) => { log('error (kept running): ' + (e && e.stack || e).toString().slice(0, 300)); });
log('courier starting: serves ' + CFG.builders.join(', ') + (CFG.owner ? '; owner ' + CFG.owner : '') + '; up to ' + CFG.maxBoxesPerOrder + ' boxes an order, ' + CFG.maxBoxesPerHour + ' an hour');
connect();
