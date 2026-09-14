import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('audio level reports measure capture and rendered playback over the complete interval', () => {
  let Processor; const messages = [];
  const context = vm.createContext({ AudioWorkletProcessor: class { constructor() { this.port = { postMessage: e => messages.push(e) }; } },
    registerProcessor: (_name, type) => { Processor = type; }, sampleRate: 24000, currentTime: 0 });
  vm.runInContext(fs.readFileSync(new URL('../web/audio-worklet.js', import.meta.url), 'utf8'), context);
  const processor = new Processor();
  processor.port.onmessage({ data: { type: 'play', pcm: new Int16Array(128 * 20).fill(16384).buffer } });
  for (let i = 0; i < 20; i++) {
    context.currentTime = i * 128 / 24000;
    processor.process([[new Float32Array(128).fill(i < 10 ? .5 : 0)]], [[new Float32Array(128)]]);
  }
  const level = messages.find(e => e.type === 'level');
  assert.ok(Math.abs(level.rms - Math.sqrt(.125)) < .0001, 'not only the final silent block');
  assert.equal(level.outputRms, .5);
  assert.ok(Math.abs(level.durationMs - 2560 / 24) < .001);
  assert.ok(Math.abs(level.endTime * 1000 - level.durationMs) < .001);
  processor.port.onmessage({ data: { type: 'mute', muted: true } });
  for (let i = 0; i < 20; i++) processor.process([[new Float32Array(128).fill(.5)]], [[new Float32Array(128)]]);
  const muted = messages.filter(e => e.type === 'level').at(-1);
  assert.equal(muted.rms, 0); assert.equal(muted.outputRms, 0);
});
