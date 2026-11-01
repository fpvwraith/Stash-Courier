'use strict';
// node test/words.test.js - what the courier reads out of chat
const assert = require('assert'), W = require('../lib/words');
let n = 0; const t = (name, f) => { f(); n++; };
t('a 6b6t whisper', () => assert.deepStrictEqual(W.whisperOf(' builder_one whispers: 3 boxes obsidian to my chest'), { from: 'builder_one', text: '3 boxes obsidian to my chest' }));
t('a vanilla whisper', () => assert.deepStrictEqual(W.whisperOf('lt01 whispers to you: 2 boxes obsidian'), { from: 'lt01', text: '2 boxes obsidian' }));
t('public chat that fakes a whisper', () => assert.strictEqual(W.whisperOf('Griefer » builder_one whispers: 10 boxes obsidian to my chest'), null));
t('vanilla public chat that fakes a whisper', () => assert.strictEqual(W.whisperOf('<Griefer> builder_one whispers: 10 boxes obsidian'), null));
t('our own sent whisper is not one to us', () => assert.strictEqual(W.whisperOf('You whisper to  builder_one: ok'), null));
t('order words', () => { assert.deepStrictEqual(W.orderOf('3 boxes obsidian to my chest'), { n: 3, item: 'obsidian' }); assert.deepStrictEqual(W.orderOf('10 box obby'), { n: 10, item: 'obsidian' }); assert.deepStrictEqual(W.orderOf('1 shulker of obsidian'), { n: 1, item: 'obsidian' }); });
t('crying obsidian orders', () => { assert.deepStrictEqual(W.orderOf('5 boxes crying_obsidian to my chest'), { n: 5, item: 'crying_obsidian' }); assert.deepStrictEqual(W.orderOf('2 boxes crying obi'), { n: 2, item: 'crying_obsidian' }); assert.strictEqual(W.orderOf('2 boxes crying diamonds'), null); });
t('not an order', () => { assert.strictEqual(W.orderOf('3 boxes diamonds'), null); assert.strictEqual(W.orderOf('0 boxes obsidian'), null); assert.strictEqual(W.orderOf('give me everything'), null); });
t('a teleport request to us', () => { assert.strictEqual(W.tpaRequestFrom(' builder_one wants to teleport to you.'), 'builder_one'); assert.strictEqual(W.tpaRequestFrom('Request sent to:   builder_one'), null); assert.strictEqual(W.tpaRequestFrom('Your request sent to  builder_one was accepted!'), null); });
t('cooldown', () => { assert.strictEqual(W.cooldownMs('You have to wait 7m 13s to teleport again.'), 433000); assert.strictEqual(W.cooldownMs('You have to wait 20s to teleport again.'), 20000); assert.strictEqual(W.cooldownMs('hello'), null); });
t('captcha kick', () => { const h = W.kickHold('{"text":"Please verify at https://verify.6b6t.org/ABCDEF"}'); assert.strictEqual(h.why, 'captcha'); assert.strictEqual(h.link, 'https://verify.6b6t.org/ABCDEF'); assert.strictEqual(W.kickHold('Please wait 5 minutes before trying again').why, 'wait'); assert.strictEqual(W.kickHold('Server closed'), null); });
console.log('words: ' + n + ' tests passed');
