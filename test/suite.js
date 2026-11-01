'use strict';
// test/suite.js - TEST ONLY: the courier against everything we could think of, on the private Paper test server.
//   node test/suite.js <server.properties> [soakMinutes]
// A real-looking stash (two rows of double chests two high behind a wall, barrels, a trapped chest it must never touch, decoy boxes,
// junk, a full chest, a reserve chest outside its radius), three builders that behave like the ARGUS sky printer (order, order again
// until it comes, accept only the courier's /tpa, pick up what lies near them, use the boxes up), then scenario after scenario,
// and a chaos soak. Every box is counted the whole time: stash + builders + used + on the ground + on the courier = what was there.
const fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const RCON = require('./rcon');
const ROOT = path.join(__dirname, '..'), RUN = path.join(__dirname, 'run-suite'), Q = path.join(RUN, 'queue');
const mineflayer = require(require.resolve('mineflayer', { paths: [ROOT] }));
const { pathfinder, Movements, goals } = require(require.resolve('mineflayer-pathfinder', { paths: [ROOT] }));
const props = Object.fromEntries(fs.readFileSync(process.argv[2], 'utf8').split(/\r?\n/).filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const SOAK_MIN = Number(process.argv[3] || 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now(), say = (m) => { const l = new Date().toTimeString().slice(0, 8) + ' [suite] ' + m; console.log(l); fs.appendFileSync(path.join(RUN, 'suite.log'), l + '\n'); };
let RC = null; const rc = async (c) => { for (let k = 0; k < 3; k++) { try { if (!RC) { RC = await RCON.connect('127.0.0.1', Number(props['rcon.port']), props['rcon.password']); RC.sock.on('close', () => { RC = null; }); } return await RC.cmd(c); } catch (e) { RC = null; await sleep(1000); } } return ''; };
const tell = (who, text) => rc('tellraw ' + who + ' ' + JSON.stringify({ text }));
const ifCount = async (what) => { const m = /count: (\d+)/i.exec(await rc('execute if ' + what)); return m ? Number(m[1]) : 0; };
const C = 'Courier', OWNER = 'Owner1', BUILDERS = ['eb01', 'eb02', 'eb03'], Y = -60;
const ITEMS = { obsidian: 'minecraft:shulker_box', crying_obsidian: 'minecraft:purple_shulker_box' };   // a full box of each is one colour, so it can be counted by id
const DECOY = { 'minecraft:red_shulker_box': 'diamonds', 'minecraft:blue_shulker_box': 'a half obsidian box', 'minecraft:green_shulker_box': 'obsidian + 1 dirt' };
const box = (id, item, n, slots, extra) => id + '[minecraft:container=[' + Array.from({ length: slots }, (_, i) => '{slot:' + i + ',item:{id:"' + item.replace(/^minecraft:/, '') + '",count:' + n + '}}').join(',') + (extra || '') + ']]';
const results = []; const check = (name, ok, extra) => { results.push({ name, ok: !!ok, extra }); say((ok ? 'PASS ' : 'FAIL ') + name + (extra ? ' - ' + extra : '')); return ok; };

// ---------------------------------------------------------------- the world
const ST = { x: 2000, z: 2000 }, SITE = { x: 7600, z: 2000 }, RESERVE = [ST.x + 45, Y, ST.z];
const SPOT = [ST.x, Y, ST.z + 2], BED = [ST.x, Y, ST.z + 3];
const containers = [];   // every stash container block the test counts: { p, kind }
const posts = { eb01: { x: SITE.x, z: SITE.z, chest: [SITE.x + 2, Y, SITE.z] }, eb02: { x: SITE.x + 40, z: SITE.z, chest: [SITE.x + 42, Y, SITE.z], full: true }, eb03: { x: SITE.x + 80, z: SITE.z, chest: null } };
async function buildWorld() {
    await rc('difficulty peaceful'); await rc('time set day'); await rc('gamerule doDaylightCycle false'); await rc('gamerule doMobSpawning false'); await rc('gamerule keepInventory false'); await rc('setworldspawn 0 ' + Y + ' 0');
    for (const [a, b] of [[ST, 60], [SITE, 120]]) await rc('forceload add ' + (a.x - 60) + ' ' + (a.z - 60) + ' ' + (a.x + b) + ' ' + (a.z + 60));
    await rc('fill ' + (ST.x - 30) + ' ' + Y + ' ' + (ST.z - 20) + ' ' + (ST.x + 50) + ' ' + (Y + 6) + ' ' + (ST.z + 30) + ' air');
    await rc('fill ' + (SITE.x - 10) + ' ' + Y + ' ' + (SITE.z - 10) + ' ' + (SITE.x + 100) + ' ' + (Y + 6) + ' ' + (SITE.z + 10) + ' air');
    for (const [n, p] of Object.entries(posts)) if (p.chest) { await rc('setblock ' + p.chest.join(' ') + ' chest'); if (p.full) for (let k = 0; k < 27; k++) await rc('item replace block ' + p.chest.join(' ') + ' container.' + k + ' with dirt 64'); }   // the builders' chests (eb02's is full)
    await rc('kill @e[type=item]');
    await rc('setblock ' + BED.join(' ') + ' red_bed[facing=south,part=foot]'); await rc('setblock ' + BED[0] + ' ' + Y + ' ' + (BED[2] + 1) + ' red_bed[facing=south,part=head]');
    // a wall between the bed and the chest rows, with one gap at its east end
    await rc('fill ' + (ST.x - 14) + ' ' + Y + ' ' + (ST.z + 7) + ' ' + (ST.x + 12) + ' ' + (Y + 3) + ' ' + (ST.z + 7) + ' stone_bricks');
    // two rows of double chests (z +10 and +14), two high; barrels at the east end; a trapped chest at the west end
    let k = 0;
    for (const z of [ST.z + 10, ST.z + 14]) for (let x = ST.x - 12; x <= ST.x + 12; x += 3) for (const y of [Y, Y + 1]) {
        await rc('setblock ' + x + ' ' + y + ' ' + z + ' chest[facing=north,type=right]'); await rc('setblock ' + (x + 1) + ' ' + y + ' ' + z + ' chest[facing=north,type=left]');
        containers.push({ p: [x, y, z], kind: 'chest', n: k }); containers.push({ p: [x + 1, y, z], kind: 'chest', n: k++ });
    }
    for (let z = ST.z + 10; z <= ST.z + 14; z++) { await rc('setblock ' + (ST.x + 18) + ' ' + Y + ' ' + z + ' barrel[facing=up]'); containers.push({ p: [ST.x + 18, Y, z], kind: 'barrel' }); }
    const TRAP = [ST.x - 18, Y, ST.z + 10]; await rc('setblock ' + TRAP.join(' ') + ' trapped_chest'); containers.push({ p: TRAP, kind: 'trapped' });
    await rc('setblock ' + RESERVE.join(' ') + ' chest'); containers.push({ p: RESERVE, kind: 'reserve' });
    return { TRAP };
}
const put = async (p, slot, what) => { if (what.length > 1400) throw new Error('RCON command too long (' + what.length + ')'); const r = await rc('item replace block ' + p.join(' ') + ' container.' + slot + ' with ' + what); if (!/Replaced/.test(r)) say('put failed at ' + p.join(' ') + ' slot ' + slot + ': ' + r.slice(0, 120)); return r; };
async function fillStash(TRAP) {
    // spread full boxes over the chests (only the first 2/3 of the slots, so there is room for its own things), decoys and junk
    const ch = containers.filter((c) => c.kind === 'chest'), ba = containers.filter((c) => c.kind === 'barrel');
    let o = 0, cr = 0;
    for (let i = 0; i < ch.length; i++) { const c = ch[i];
        if (i === 5) { for (let s = 0; s < 27; s++) await put(c.p, s, 'dirt 64'); continue; }   // one full chest of dirt
        if (i % 4 === 0) { for (let s = 0; s < 3; s++) { await put(c.p, s, box(ITEMS.obsidian, 'minecraft:obsidian', 64, 27)); o++; } }
        if (i % 4 === 1) { for (let s = 0; s < 2; s++) { await put(c.p, s, box(ITEMS.crying_obsidian, 'minecraft:crying_obsidian', 64, 27)); cr++; } await put(c.p, 5, 'cobblestone 64'); }
        if (i % 4 === 2) { await put(c.p, 0, box(ITEMS.obsidian, 'minecraft:obsidian', 64, 27)); o++; await put(c.p, 1, box('minecraft:red_shulker_box', 'minecraft:diamond', 64, 27)); }
        if (i % 4 === 3) { await put(c.p, 0, box('minecraft:blue_shulker_box', 'minecraft:obsidian', 64, 10)); await put(c.p, 1, box('minecraft:green_shulker_box', 'minecraft:obsidian', 64, 26, ',{slot:26,item:{id:"minecraft:dirt",count:1}}')); }
    }
    for (const b of ba) { await put(b.p, 0, box(ITEMS.obsidian, 'minecraft:obsidian', 64, 27)); o++; await put(b.p, 1, box(ITEMS.crying_obsidian, 'minecraft:crying_obsidian', 64, 27)); cr++; }
    for (let s = 0; s < 5; s++) await put(TRAP, s, box(ITEMS.obsidian, 'minecraft:obsidian', 64, 27));   // never to be touched
    for (let s = 0; s < 10; s++) await put(RESERVE, s, box(ITEMS.obsidian, 'minecraft:obsidian', 64, 27));   // outside the radius: never to be touched
    return { o, cr };
}
// ---------------------------------------------------------------- counting
async function countIn(c, id) { return ifCount('data block ' + c.p.join(' ') + ' Items[{id:"' + id + '"}]'); }
async function stashCount(id, kinds) { let n = 0; for (const c of containers) if (!kinds || kinds.includes(c.kind)) n += await countIn(c, id); return n; }
const used = { obsidian: 0, crying_obsidian: 0 }, added = { obsidian: 0, crying_obsidian: 0 };
async function census(label) {
    const out = {};
    for (const [item, id] of Object.entries(ITEMS)) {
        const stash = await stashCount(id), b = {};
        let builders = 0; for (const n of BUILDERS) { const inv = await ifCount('data entity ' + n + ' Inventory[{id:"' + id + '"}]'); const ch = posts[n].chest ? await countIn({ p: posts[n].chest }, id) : 0; b[n] = inv + ch; builders += inv + ch; }
        const ground = await ifCount('entity @e[type=item,nbt={Item:{id:"' + id + '"}}]');
        const courier = await ifCount('data entity ' + C + ' Inventory[{id:"' + id + '"}]');
        const list = await rc('list'), courierOn = /Courier/.test(list) && BUILDERS.every((n) => new RegExp('\b' + n + '\b').test(list));
        out[item] = { stash, builders, used: used[item], ground, courier, courierOn, total: stash + builders + used[item] + ground + courier, b };
    }
    return out;
}
let START = null;
async function conserve(label) {
    const c = await census(label); let ok = true; const parts = [];
    for (const it of Object.keys(ITEMS)) { const want = START[it] + added[it]; const x = c[it]; parts.push(it + ' ' + x.total + '/' + want + ' (stash ' + x.stash + ', builders ' + x.builders + ', used ' + x.used + ', ground ' + x.ground + ', courier ' + x.courier + ')'); if (x.courierOn && x.total !== want) ok = false; if (!x.courierOn && x.total > want) ok = false; }
    return check('every box accounted for: ' + label, ok, parts.join(' | ')) ;
}
async function decoysIntact() {
    let ok = true; const parts = [];
    for (const id of Object.keys(DECOY)) { const n = await stashCount(id, ['chest', 'barrel']); parts.push(DECOY[id] + ' ' + n); if (n !== DEC0[id]) ok = false; }
    const trap = await stashCount(ITEMS.obsidian, ['trapped']), res = await stashCount(ITEMS.obsidian, ['reserve']); parts.push('trapped chest ' + trap + '/5', 'reserve ' + res + '/' + RES0);
    if (trap !== 5 || res !== RES0) ok = false;
    return check('decoys, trapped chest and reserve untouched', ok, parts.join(', '));
}
let DEC0 = {}, RES0 = 10;

// ---------------------------------------------------------------- 6b6t's commands, acted out
const pending = []; const emu = { cooldownNext: 0, ignore: new Set(), offline: new Set() };
async function act(who, cmd) {
    const [c0, ...rest] = cmd.trim().split(/\s+/); const c = c0.toLowerCase();
    if (c === '/msg' || c === '/w' || c === '/tell') { const to = rest[0], text = rest.slice(1).join(' '); if (!(/eb0|Owner1|Courier/.test(to))) return; if (!(await isOnline(to))) { await tell(who, 'Player not found.'); return; } await tell(who, 'You whisper to  ' + to + ': ' + text); await tell(to, ' ' + who + ' whispers: ' + text); if (to === OWNER) ownerHeard.push(text); return; }
    if (c === '/tpa') { const to = rest[0];
        if (who === C && emu.cooldownNext > 0) { emu.cooldownNext--; await tell(who, 'You have to wait 0m 15s to teleport again.'); say('emu: told the courier to wait 15 s (cooldown)'); return; }
        if (!(await isOnline(to))) { await tell(who, 'Player not found.'); return; }
        pending.push({ from: who, to, t: Date.now() }); await tell(who, 'Request sent to:   ' + to); await tell(to, ' ' + who + ' wants to teleport to you.'); return; }
    if (c === '/tpy') { const from = rest[0], i = pending.findIndex((p) => p.to === who && p.from === from && Date.now() - p.t < 60000); if (i < 0) { await tell(who, 'There is no request to accept from ' + from + '!'); return; }
        pending.splice(i, 1); await tell(from, 'Your request sent to  ' + who + ' was accepted!'); await tell(from, 'Teleporting in 3 seconds... [Cancel]'); setTimeout(() => rc('tp ' + from + ' ' + who), 3000); return; }
    if (c === '/kill') { await rc('kill ' + who); return; }
    if (c === '/home') { await tell(who, 'Home ' + (rest[0] || '') + ' does not exist.'); return; }
    say('emu: unknown command from ' + who + ': ' + cmd);
}
const ownerHeard = [];
const isOnline = async (n) => new RegExp('\\b' + n + '\\b').test(await rc('list'));
async function queueLoop() { for (;;) { let fsx = []; try { fsx = fs.readdirSync(Q).filter((f) => f.endsWith('.json')).sort(); } catch (_) {} for (const f of fsx) { const p = path.join(Q, f); let r = null; try { r = JSON.parse(fs.readFileSync(p, 'utf8')); fs.unlinkSync(p); } catch (_) {} if (r) act(r.bot, r.cmd).catch((e) => say('act: ' + e.message)); } await sleep(150); } }

// ---------------------------------------------------------------- the builders: like the ARGUS sky printer
const B = {};   // name -> { bot, need: {item, n}, lastOrder, got, auto }
function startBuilder(name) {
    return new Promise((res) => {
        const b = mineflayer.createBot({ host: '127.0.0.1', port: Number(props['server-port']), username: name, auth: 'offline', version: '1.21.11' });
        b.loadPlugin(pathfinder); b.on('error', () => {}); b.on('kicked', () => {});
        const st = B[name] = Object.assign(B[name] || { need: null, lastOrder: 0, auto: false, ignoreTpa: false }, { bot: b });
        b.on('messagestr', (m) => { if (new RegExp('^\\s*' + C + ' wants to teleport to you').test(String(m)) && !st.ignoreTpa) act(name, '/tpy ' + C); });
        b.once('spawn', async () => { await sleep(1500); const p = posts[name]; await rc('tp ' + name + ' ' + p.x + ' ' + Y + ' ' + p.z); await sleep(1000); const mv = new Movements(b); mv.canDig = false; b.pathfinder.setMovements(mv); res(b); });
        b.on('end', () => { if (st.bot === b) st.bot = null; });
    });
}
async function builderLoop() {
    for (;;) {
        for (const name of BUILDERS) { const st = B[name]; if (!st || !st.bot || !st.bot.entity) continue; const b = st.bot;
            // pick up shulker boxes lying within 8 blocks (the printer walks to things near it)
            const it = Object.values(b.entities).find((e) => e && e.name === 'item' && e.position.distanceTo(b.entity.position) < 8 && e.position.distanceTo(b.entity.position) > 0.8);
            if (it) { try { b.pathfinder.setGoal(new goals.GoalBlock(Math.floor(it.position.x), Math.floor(it.position.y), Math.floor(it.position.z))); } catch (_) {} }
            else if (b.entity.position.distanceTo(b.entity.position.clone().set(posts[name].x + 0.5, Y, posts[name].z + 0.5)) > 1.5) { try { b.pathfinder.setGoal(new goals.GoalBlock(posts[name].x, Y, posts[name].z)); } catch (_) {} }
            // order (again every 60 s, like the printer's 8 min) until it has what it asked for
            if (st.need && Date.now() - st.lastOrder > 60000) { st.lastOrder = Date.now(); act(name, '/msg ' + C + ' ' + st.need.n + ' boxes ' + st.need.item + ' to my chest'); }
        }
        await sleep(1000);
    }
}
async function holding(name, item) { const id = ITEMS[item]; return (await ifCount('data entity ' + name + ' Inventory[{id:"' + id + '"}]')) + (posts[name].chest ? await countIn({ p: posts[name].chest }, id) : 0); }
async function useUp(name) {   // the builder places what it got: the boxes leave the world and are counted as used
    for (const [item, id] of Object.entries(ITEMS)) {
        const inv = await ifCount('data entity ' + name + ' Inventory[{id:"' + id + '"}]'); if (inv) { await rc('clear ' + name + ' ' + id); used[item] += inv; }
        if (posts[name].chest) for (let s = 0; s < 27; s++) { const n = await ifCount('data block ' + posts[name].chest.join(' ') + ' Items[{Slot:' + s + 'b,id:"' + id + '"}]'); if (n) { await put(posts[name].chest, s, 'air'); used[item] += n; } }
    }
}
async function order(name, item, n) { const st = B[name]; const had = await holding(name, item); st.need = { item, n, had }; st.lastOrder = 0; }
async function delivered(name, sec) { const st = B[name], t0 = Date.now(); while (Date.now() - t0 < sec * 1000) { if (st.need && (await holding(name, st.need.item)) >= st.need.had + st.need.n) { const n = st.need.n; st.need = null; return n; } await sleep(2000); } return 0; }

// ---------------------------------------------------------------- the owner and the courier
let owner = null, courier = null;
function startOwner() { return new Promise((res) => { const b = mineflayer.createBot({ host: '127.0.0.1', port: Number(props['server-port']), username: OWNER, auth: 'offline', version: '1.21.11' }); b.on('error', () => {}); b.on('kicked', () => {});
    b.on('messagestr', (m) => { if (new RegExp('^\\s*' + C + ' wants to teleport to you').test(String(m))) act(OWNER, '/tpy ' + C); }); b.once('spawn', async () => { await sleep(1500); await rc('tp ' + OWNER + ' ' + ST.x + ' ' + Y + ' ' + (ST.z + 1)); res(b); }); }); }
const env = Object.assign({}, process.env, { COURIER_HOME: RUN, EMU_QUEUE: Q });
function startCourier() { const p = spawn(process.execPath, ['-r', path.join(__dirname, 'emu.js'), path.join(ROOT, 'courier.js')], { env, cwd: ROOT }); p.stdout.on('data', (d) => fs.appendFileSync(path.join(RUN, 'courier.out'), d)); p.stderr.on('data', (d) => fs.appendFileSync(path.join(RUN, 'courier.out'), 'ERR ' + d)); p.on('exit', (c) => say('courier process exited (' + c + ')')); return p; }
const logText = () => { try { return fs.readFileSync(path.join(RUN, 'logs', 'courier.log'), 'utf8'); } catch (_) { return ''; } };
const logSince = (mark) => logText().slice(mark);
async function until(name, test, sec) { const t0 = Date.now(); while (Date.now() - t0 < sec * 1000) { try { if (await test()) return true; } catch (_) {} await sleep(1000); } say('timed out (' + sec + ' s): ' + name); return false; }
const ownerSays = (t) => act(OWNER, '/msg ' + C + ' ' + t);
const idle = () => until('courier idle at the stash', async () => { const l = logText(); const last = l.split('\n').filter(Boolean).slice(-1)[0] || ''; return /back at the stash|indexed|the boxes are back|on the main server|ignored/.test(last) && (await isOnline(C)); }, 300);

// ---------------------------------------------------------------- the scenarios
async function scenarios() {
    // 1. setup: come, bed, index
    let m = logText().length; await ownerSays('come');
    check('1 the owner brings it to the stash ("come")', await until('at the stash', async () => { const p = /\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/.exec(await rc('data get entity ' + C + ' Pos')); return p && Math.abs(+p[1] - ST.x) < 6 && Math.abs(+p[3] - ST.z) < 6; }, 60));
    await sleep(2000); await rc('tp ' + C + ' ' + SPOT.join(' ')); await sleep(1500);
    m = logText().length; await ownerSays('bed');
    check('1 "bed" saves the stash spot', await until('spot', () => fs.existsSync(path.join(RUN, 'data', 'stash-spot.json')), 30));
    check('1 the stash is indexed', await until('indexed', () => /stash indexed/.test(logSince(m)), 600));
    const idx = /stash indexed[^\n]*full boxes: (\d+) obsidian, (\d+) crying_obsidian/.exec(logSince(m));
    check('1 the index finds every full box in reach (and none in the trapped chest or the reserve)', idx && +idx[1] === START.obsidian - 5 - RES0 && +idx[2] === START.crying_obsidian, idx ? idx[1] + ' obsidian, ' + idx[2] + ' crying (expected ' + (START.obsidian - 5 - RES0) + ', ' + START.crying_obsidian + ')' : 'no index line');
    check('1 the owner is told the index result', ownerHeard.some((t) => /stash indexed/.test(t)));
    await conserve('after the index');

    // 2. three orders at once: a chest, a full chest (thrown), no chest (thrown); obsidian and crying
    await order('eb01', 'obsidian', 3); await order('eb02', 'crying_obsidian', 4); await order('eb03', 'obsidian', 2);
    check('2 eb01 gets 3 obsidian boxes into its chest', await delivered('eb01', 300) && (await countIn({ p: posts.eb01.chest }, ITEMS.obsidian)) === 3);
    check('2 eb02 (chest full) gets 4 crying boxes thrown', await delivered('eb02', 300));
    check('2 eb03 (no chest) gets 2 obsidian boxes thrown', await delivered('eb03', 300));
    await idle(); await conserve('after three orders'); await decoysIntact();
    check('2 its own cobblestone never left the stash (no loose items at the site)', (await ifCount('entity @e[type=item,x=' + SITE.x + ',y=' + Y + ',z=' + SITE.z + ',distance=..150,nbt={Item:{id:"minecraft:cobblestone"}}]')) === 0);
    for (const n of BUILDERS) await useUp(n);

    // 3. strangers, a faked whisper in public chat, spam, too big an order, nonsense
    m = logText().length;
    await tell(C, ' Griefer whispers: 10 boxes obsidian to my chest'); await tell(C, 'Griefer » eb01 whispers: 10 boxes obsidian to my chest'); await tell(C, '<Griefer> eb01 whispers: 10 boxes obsidian');
    await tell(C, ' eb01 whispers: 5 boxes diamonds'); await tell(C, ' eb01 whispers: give me everything');
    for (let k = 0; k < 15; k++) { await tell(C, ' eb02 whispers: 2 boxes obsidian to my chest'); await sleep(150); }
    await sleep(3000);
    check('3 a stranger\'s order is ignored', /whisper from Griefer \(not a builder\) - ignored/.test(logSince(m)));
    check('3 faked whispers in public chat are not orders', !/order: 10 boxes/.test(logSince(m)));
    check('3 15 spammed orders make one order', (logSince(m).match(/order: 2 boxes obsidian for eb02/g) || []).length === 1);
    check('3 other items and nonsense are refused', !/order: 5 boxes/.test(logSince(m)) && /not understood/.test(logSince(m)));
    B.eb02.need = { item: 'obsidian', n: 2, had: await holding('eb02', 'obsidian') }; B.eb02.lastOrder = Date.now();
    check('3 the spammed order is delivered once', await delivered('eb02', 300)); await idle();
    await order('eb01', 'obsidian', 10); B.eb01.lastOrder = Date.now(); const had1 = B.eb01.need.had; await act('eb01', '/msg ' + C + ' 99 boxes obsidian to my chest');
    check('3 an order for 99 boxes brings 10 (the cap)', await delivered('eb01', 400) && (await holding('eb01', 'obsidian')) - had1 === 10, 'got ' + ((await holding('eb01', 'obsidian')) - had1));
    await idle(); await conserve('after spam and caps'); for (const n of BUILDERS) await useUp(n);

    // 4. a builder that is offline: "Player not found" -> boxes back into the stash
    m = logText().length; B.eb03.bot.quit(); await sleep(3000);
    await tell(C, ' eb03 whispers: 2 boxes obsidian to my chest');
    check('4 builder offline: the trip is called off', await until('called off', () => /eb03 did not take the teleport/.test(logSince(m)), 240));
    check('4 the boxes go back into the stash', await until('back', () => /the boxes are back in the stash/.test(logSince(m)), 120));
    await conserve('after an offline builder'); await startBuilder('eb03');

    // 5. a builder that never accepts: 3 asks, then back
    m = logText().length; B.eb02.ignoreTpa = true; await order('eb02', 'obsidian', 1);
    check('5 builder does not accept: 3 asks, then the boxes go back', await until('3 asks', () => /\/tpa eb02 sent \(3 of 3\)/.test(logSince(m)) && /the boxes are back in the stash/.test(logSince(m)), 400));
    B.eb02.ignoreTpa = false; B.eb02.lastOrder = 0;
    check('5 ...and when it accepts again it is delivered', await delivered('eb02', 400)); await idle(); await conserve('after a builder that did not accept'); for (const n of BUILDERS) await useUp(n);

    // 6. teleport cooldown
    m = logText().length; emu.cooldownNext = 1; await order('eb01', 'crying_obsidian', 2);
    check('6 a teleport cooldown is waited out, then delivered', await delivered('eb01', 300) && /teleport cooldown - waiting/.test(logSince(m))); await idle(); await useUp('eb01');

    // 7. kicked while packing at the stash
    m = logText().length; await order('eb03', 'obsidian', 3);
    await until('packing', () => /trip for eb03/.test(logSince(m)) || /\/tpa eb03/.test(logSince(m)), 200); await rc('kick ' + C + ' kicked while packing');
    check('7 kicked while packing: it comes back and delivers', await delivered('eb03', 500)); await idle(); await conserve('after a kick at the stash'); await useUp('eb03');

    // 8. kicked right after arriving at the builder, before handing over
    m = logText().length; await order('eb03', 'obsidian', 2);
    await until('arrived', async () => { const p = /\[(-?[\d.]+)d/.exec(await rc('data get entity ' + C + ' Pos')); return p && Math.abs(+p[1] - posts.eb03.x) < 10; }, 300); await rc('kick ' + C + ' kicked at the builder');
    check('8 kicked at the builder: on rejoin it hands the boxes over there', await delivered('eb03', 500) && /beside it - handing them over/.test(logSince(m)));
    await idle(); check('8 ...and goes home', /back at the stash/.test(logSince(m))); await conserve('after a kick at the builder'); await useUp('eb03');

    // 8b. a server restart at the hand-over: the courier is back before the builder - it waits for the builder instead of /kill
    m = logText().length; await order('eb03', 'obsidian', 2);
    await until('arrived', async () => { const p = /\[(-?[\d.]+)d/.exec(await rc('data get entity ' + C + ' Pos')); return p && Math.abs(+p[1] - posts.eb03.x) < 10; }, 300);
    await rc('kick ' + C + ' restart'); await rc('kick eb03 restart'); setTimeout(() => startBuilder('eb03').catch(() => {}), 75000);
    check('8b restart at the hand-over: it waits for the builder and hands over, nothing dropped', await delivered('eb03', 600) && /waiting up to 3 min for one to come back/.test(logSince(m)) && !/LOST/.test(logSince(m)));
    await idle(); await conserve('after a restart at the hand-over'); await useUp('eb03');

    // 9. the bed is broken during a trip: /kill puts it at world spawn -> pause, tell the owner; fixed by the owner
    m = logText().length; await order('eb01', 'obsidian', 1);
    await until('trip', () => /\/tpa eb01/.test(logSince(m)), 200); await rc('setblock ' + BED.join(' ') + ' air'); await rc('setblock ' + BED[0] + ' ' + Y + ' ' + (BED[2] + 1) + ' air');
    await delivered('eb01', 300);
    check('9 no bed: it pauses and tells the owner', await until('paused', () => /NOT BACK AT THE STASH - paused/.test(logSince(m)) && ownerHeard.some((t) => /paused/.test(t)), 240));
    await rc('setblock ' + BED.join(' ') + ' red_bed[facing=south,part=foot]'); await rc('setblock ' + BED[0] + ' ' + Y + ' ' + (BED[2] + 1) + ' red_bed[facing=south,part=head]');
    await rc('tp ' + OWNER + ' ' + ST.x + ' ' + Y + ' ' + (ST.z + 1)); m = logText().length; await ownerSays('come');
    await until('at the stash again', async () => { const p = /\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/.exec(await rc('data get entity ' + C + ' Pos')); return p && Math.abs(+p[1] - ST.x) < 6 && Math.abs(+p[3] - ST.z) < 6; }, 60);
    await rc('tp ' + C + ' ' + SPOT.join(' ')); await sleep(1500); await ownerSays('bed'); await sleep(3000); await ownerSays('resume');
    await useUp('eb01'); await order('eb01', 'obsidian', 1);
    check('9 after "come", "bed", "resume" it delivers again', await delivered('eb01', 600)); await idle(); await conserve('after the bed was fixed'); await useUp('eb01');

    // 10. the stash runs out of crying obsidian: the owner is told; refilled, it carries on by itself
    m = logText().length; let took = 0;
    for (const c of containers.filter((x) => x.kind === 'chest' || x.kind === 'barrel')) for (let s = 0; s < 27; s++) { const n = await ifCount('data block ' + c.p.join(' ') + ' Items[{Slot:' + s + 'b,id:"' + ITEMS.crying_obsidian + '"}]'); if (n) { await put(c.p, s, 'air'); took++; } }
    added.crying_obsidian -= took; say('took ' + took + ' crying boxes out of the stash');
    await order('eb02', 'crying_obsidian', 2);
    check('10 empty stash: the owner is told', await until('told', () => ownerHeard.some((t) => /no full crying_obsidian boxes left/.test(t)), 400));
    const refill = containers.find((x) => x.kind === 'chest' && x.n === 20); for (let s = 20; s < 24; s++) await put(refill.p, s, box(ITEMS.crying_obsidian, 'minecraft:crying_obsidian', 64, 27)); added.crying_obsidian += 4;
    check('10 refilled: it finds the new boxes by itself and delivers', await delivered('eb02', 900)); await idle(); await conserve('after the stash ran out and was refilled'); await useUp('eb02');

    // 11. pockets full of junk: put away at the stash before the trip
    m = logText().length; for (let k = 0; k < 30; k++) await rc('give ' + C + ' cobblestone 64');
    await order('eb01', 'obsidian', 2);
    check('11 a full inventory of junk is put away first, then delivered', await delivered('eb01', 600) && /its own things are left/.test(logSince(m)));
    check('11 no junk reached the build site', (await ifCount('entity @e[type=item,x=' + SITE.x + ',y=' + Y + ',z=' + SITE.z + ',distance=..150,nbt={Item:{id:"minecraft:cobblestone"}}]')) === 0);
    await idle(); await useUp('eb01');

    // 12. the lobby: joins in adventure mode, waits there, carries on once in survival
    m = logText().length; await rc('kick ' + C + ' to the lobby');
    await until('rejoined', async () => isOnline(C), 700); await rc('gamemode adventure ' + C);   // its reconnect wait grows after several short sessions (up to 10 min) await sleep(25000);
    check('12 it does nothing while in the lobby (adventure mode)', !/trip for/.test(logSince(m).split('logged in').slice(-1)[0] || ''));
    await order('eb03', 'obsidian', 1); await sleep(5000); await rc('gamemode survival ' + C);
    check('12 out of the lobby it delivers', await delivered('eb03', 400)); await idle(); await useUp('eb03');

    // 13. a captcha kick: it stays offline (1 min in this test) instead of reconnecting at once
    m = logText().length; const tk = Date.now(); await rc('kick ' + C + ' Please verify you are human: https://verify.6b6t.org/TESTLINK');
    await until('rejoined after captcha', async () => /logged in/.test(logSince(m)), 240); const away = (Date.now() - tk) / 1000;
    check('13 captcha kick: the link is in the log and it stays offline ~1 min', /CAPTCHA: open this link[^\n]*TESTLINK/.test(logSince(m)) && away >= 55, Math.round(away) + ' s offline');
    await idle();

    // 14. owner commands
    m = logText().length; ownerHeard.length = 0; await ownerSays('pause'); await sleep(3000); await order('eb01', 'obsidian', 1); await sleep(30000);
    check('14 "pause" stops trips', !/trip for eb01/.test(logSince(m)));
    await ownerSays('status'); await sleep(4000); check('14 "status" answers', ownerHeard.some((t) => /delivered/.test(t) && /PAUSED/.test(t)), ownerHeard.slice(-1)[0]);
    await ownerSays('resume'); check('14 "resume" carries on', await delivered('eb01', 300)); await idle(); await useUp('eb01');
    await conserve('end of the scenarios'); await decoysIntact();
}

// ---------------------------------------------------------------- the soak: builders use boxes up and order more, with chaos
async function soak(min) {
    say('SOAK for ' + min + ' min'); const tEnd = Date.now() + min * 60000; let nextChaos = Date.now() + 120000, nextCheck = Date.now() + 300000, deliveredN = 0;
    for (const n of BUILDERS) { B[n].auto = true; B[n].ignoreTpa = false; }
    while (Date.now() < tEnd) {
        for (const n of BUILDERS) { const st = B[n]; if (!st.bot) continue;
            if (!st.need) { if (!st.restUntil) st.restUntil = Date.now() + 20000 + Math.random() * 60000; if (Date.now() > st.restUntil) { st.restUntil = 0; await useUp(n); await order(n, Math.random() < 0.6 ? 'obsidian' : 'crying_obsidian', 1 + Math.floor(Math.random() * 6)); } }
            else if ((await holding(n, st.need.item)) >= st.need.had + st.need.n) { deliveredN += st.need.n; st.need = null; }
        }
        // keep the stash stocked: when it is low, a "player" puts more boxes in
        for (const [item, id] of Object.entries(ITEMS)) { const n = await stashCount(id, ['chest', 'barrel']); if (n < 8) { const c = containers.filter((x) => x.kind === 'chest' && x.n !== 5)[Math.floor(Math.random() * 30)]; let k = 0; for (let s = 18; s < 26; s++) { if (!(await ifCount('data block ' + c.p.join(' ') + ' Items[{Slot:' + s + 'b}]'))) { await put(c.p, s, box(id, 'minecraft:' + item, 64, 27)); added[item]++; k++; } } say('stash refill: ' + k + ' ' + item + ' boxes'); } }
        if (Date.now() > nextChaos) {
            nextChaos = Date.now() + (120 + Math.random() * 360) * 1000; const r = Math.random();
            if (r < 0.25) { say('chaos: kick the courier'); await rc('kick ' + C + ' chaos'); }
            else if (r < 0.40) { say('chaos: everyone kicked (a server restart)'); for (const n of BUILDERS) await useUp(n); for (const n of [C, ...BUILDERS]) await rc('kick ' + n + ' restart'); for (const n of BUILDERS) setTimeout(() => startBuilder(n).catch(() => {}), 20000 + Math.random() * 40000); }
            else if (r < 0.55) { const n = BUILDERS[Math.floor(Math.random() * 3)]; say('chaos: ' + n + ' goes offline for 3 min'); await useUp(n); if (B[n].bot) B[n].bot.quit(); setTimeout(() => startBuilder(n).catch(() => {}), 180000); }
            else if (r < 0.70) { say('chaos: teleport cooldown'); emu.cooldownNext = 1; }
            else if (r < 0.80) { const n = BUILDERS[Math.floor(Math.random() * 3)]; say('chaos: ' + n + ' ignores teleport requests for 4 min'); B[n].ignoreTpa = true; setTimeout(() => { B[n].ignoreTpa = false; }, 240000); }
            else if (r < 0.90) { say('chaos: junk in the courier\'s pockets'); for (let k = 0; k < 8; k++) await rc('give ' + C + ' gravel 64'); }
            else { say('chaos: a decoy box lands in a supply chest'); const c = containers.filter((x) => x.kind === 'chest' && x.n !== 5)[Math.floor(Math.random() * 30)]; let free = -1; for (let s2 = 26; s2 >= 18 && free < 0; s2--) if (!(await ifCount('data block ' + c.p.join(' ') + ' Items[{Slot:' + s2 + 'b}]'))) free = s2; if (free >= 0) { await put(c.p, free, box('minecraft:red_shulker_box', 'minecraft:diamond', 64, 27)); DEC0['minecraft:red_shulker_box'] = (DEC0['minecraft:red_shulker_box'] || 0) + 1; } }   // an empty slot: replacing a decoy made the count look one short
        }
        if (Date.now() > nextCheck) { nextCheck = Date.now() + 300000; say('soak: ' + Math.round((min * 60000 - (tEnd - Date.now())) / 60000) + ' min, ' + deliveredN + ' boxes delivered'); if (await isOnline(C)) { const t = logText().split('\n').filter(Boolean).slice(-1)[0] || ''; if (!/trip for|\/tpa|at eb0|carrying/.test(t)) await conserve('soak'); } }
        await sleep(3000);
    }
    for (const n of BUILDERS) B[n].need = null;
    await sleep(60000); await idle();
    check('SOAK: boxes delivered', deliveredN > 0, deliveredN + ' boxes in ' + min + ' min');
    await conserve('end of the soak'); await decoysIntact();
    const lost = (/"lost":(\d+)/.exec(fs.readFileSync(path.join(RUN, 'data', 'stats.json'), 'utf8')) || [])[1]; check('SOAK: the courier lost nothing', String(lost) === '0', 'stats lost=' + lost);
}

(async () => {
    fs.rmSync(RUN, { recursive: true, force: true }); fs.mkdirSync(Q, { recursive: true });
    fs.writeFileSync(path.join(RUN, 'config.json'), JSON.stringify({ host: '127.0.0.1', port: Number(props['server-port']), username: C, auth: 'offline', owner: OWNER, builders: BUILDERS, items: ['obsidian', 'crying_obsidian'], maxBoxesPerOrder: 10, maxBoxesPerHour: 5000, tickEnd: false, tpaWaitSec: 20, captchaHoldMin: 1, stashRadius: 32 }));
    for (const n of [C, OWNER, ...BUILDERS]) await rc('kick ' + n + ' new test');
    queueLoop();
    const { TRAP } = await buildWorld(); await sleep(2000);
    const f = await fillStash(TRAP); say('stash: ' + f.o + ' obsidian + ' + f.cr + ' crying boxes in reach, 5 in the trapped chest, ' + RES0 + ' in the reserve');
    for (const id of Object.keys(DECOY)) DEC0[id] = await stashCount(id, ['chest', 'barrel']);
    owner = await startOwner(); for (const n of BUILDERS) await startBuilder(n); for (const n of [OWNER, ...BUILDERS]) await rc('clear ' + n); builderLoop();   // their inventories survive from earlier runs
    await rc('clear ' + C); courier = startCourier();
    await until('courier joins', async () => /on the main server/.test(logText()), 90);
    await rc('clear ' + C); await rc('give ' + C + ' bread 8');
    START = {}; const c0 = await census('start'); for (const it of Object.keys(ITEMS)) START[it] = c0[it].total; say('start: ' + JSON.stringify(START));
    try { await scenarios(); } catch (e) { say('scenario error: ' + e.stack); check('scenarios ran to the end', false, e.message); }
    if (SOAK_MIN > 0) { try { await soak(SOAK_MIN); } catch (e) { say('soak error: ' + e.stack); check('soak ran to the end', false, e.message); } }
    fs.writeFileSync(path.join(RUN, 'STOP'), ''); try { courier.kill('SIGINT'); } catch (_) {}
    for (const n of BUILDERS) try { B[n].bot && B[n].bot.quit(); } catch (_) {} try { owner.quit(); } catch (_) {}
    await sleep(3000);
    for (const [a, b] of [[ST, 60], [SITE, 120]]) await rc('forceload remove ' + (a.x - 60) + ' ' + (a.z - 60) + ' ' + (a.x + b) + ' ' + (a.z + 60));
    await rc('difficulty hard'); await rc('gamerule doDaylightCycle true'); await rc('gamerule doMobSpawning true');
    const bad = results.filter((r) => !r.ok); say('RESULT ' + (bad.length ? 'FAIL ' + bad.length + ': ' + bad.map((r) => r.name).join(' ; ') : 'PASS') + ' - ' + (results.length - bad.length) + '/' + results.length + ' in ' + Math.round((Date.now() - T0) / 60000) + ' min');
    fs.writeFileSync(path.join(RUN, 'results.json'), JSON.stringify(results, null, 1));
    process.exit(bad.length ? 1 : 0);
})().catch((e) => { say('error: ' + e.stack); process.exit(2); });
