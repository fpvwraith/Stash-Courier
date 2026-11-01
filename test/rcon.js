'use strict';
// test/rcon.js - a small RCON client for the private test server (one connection, requests in order).
const net = require('net');
function connect(host, port, password) {
    return new Promise((resolve, reject) => {
        const sock = net.connect(port, host); let buf = Buffer.alloc(0), id = 100; const wait = new Map();
        sock.on('data', (d) => {
            buf = Buffer.concat([buf, d]);
            while (buf.length >= 4) {
                const len = buf.readInt32LE(0); if (buf.length < len + 4) break;
                const rid = buf.readInt32LE(4), body = buf.slice(12, 4 + len - 2).toString('utf8'); buf = buf.slice(4 + len);
                const w = wait.get(rid); if (w) { wait.delete(rid); w.resolve(body); }
            }
        });
        const send = (type, body) => new Promise((res, rej) => {
            const rid = ++id, b = Buffer.from(body, 'utf8'), p = Buffer.alloc(14 + b.length);
            p.writeInt32LE(10 + b.length, 0); p.writeInt32LE(rid, 4); p.writeInt32LE(type, 8); b.copy(p, 12); p.writeInt16LE(0, 12 + b.length);
            wait.set(rid, { resolve: res, reject: rej }); sock.write(p);
            setTimeout(() => { if (wait.has(rid)) { wait.delete(rid); rej(new Error('rcon timeout: ' + body.slice(0, 60))); } }, 15000);
        });
        sock.on('error', (e) => { for (const w of wait.values()) w.reject(e); wait.clear(); reject(e); });
        sock.on('close', () => { for (const w of wait.values()) w.reject(new Error('rcon closed')); wait.clear(); });
        sock.on('connect', async () => {
            try { const r = await send(3, password); resolve({ cmd: (c) => send(2, c), close: () => sock.end(), sock }); } catch (e) { reject(e); }
        });
    });
}
module.exports = { connect };
