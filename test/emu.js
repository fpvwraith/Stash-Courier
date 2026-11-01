'use strict';
// test/emu.js - TEST ONLY, preloaded into the courier on the private test server (node -r ./test/emu.js courier.js).
// The test server has none of 6b6t's own commands (/tpa /tpy /msg /kill /home ...), so the courier's command is not sent:
// it is written to EMU_QUEUE and test/e2e.js acts it out by RCON with 6b6t's wording. The courier never loads this on its own.
const fs = require('fs'), path = require('path');
const Q = process.env.EMU_QUEUE;
if (Q) {
    fs.mkdirSync(Q, { recursive: true });
    const EMU = /^\/(tpa|tpy|tpn|msg|w|tell|kill|home|sethome)\b/i;
    let seq = 0;
    const mineflayer = require(require.resolve('mineflayer', { paths: [path.join(__dirname, '..')] }));
    const create0 = mineflayer.createBot;
    mineflayer.createBot = function (opts) {
        const bot = create0.apply(this, arguments);
        let chat0 = null;
        const wrapped = (msg) => {
            const m = String(msg || '');
            if (EMU.test(m)) { const f = path.join(Q, Date.now() + '-' + (++seq) + '.json'); fs.writeFileSync(f + '.tmp', JSON.stringify({ bot: bot.username, cmd: m })); fs.renameSync(f + '.tmp', f); return; }
            return chat0 ? chat0(msg) : undefined;
        };
        Object.defineProperty(bot, 'chat', { configurable: true, get: () => wrapped, set: (v) => { chat0 = v; } });
        return bot;
    };
}
