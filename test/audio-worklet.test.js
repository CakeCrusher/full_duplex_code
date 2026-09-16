import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { Timeline } from '../src/timeline.js';

function fixture() {
  let Processor; const messages = [], rendered = [];
  const context = vm.createContext({ AudioWorkletProcessor: class { constructor() { this.port = { postMessage: e => messages.push(e) }; } },
    registerProcessor: (_name, type) => { Processor = type; }, sampleRate: 24000, currentTime: 0 });
  vm.runInContext(fs.readFileSync(new URL('../web/audio-worklet.js', import.meta.url), 'utf8'), context);
  const processor = new Processor();
  const send = data => processor.port.onmessage({ data });
  const run = (value = 0, blocks = 20) => {
    for (let i = 0; i < blocks; i++) {
      const output = new Float32Array(128);
      processor.process([[new Float32Array(128).fill(value)]], [[output]]);
      rendered.push(...output); context.currentTime += 128 / 24000;
    }
  };
  const input = () => messages.filter(e => e.type === 'input').flatMap(e => [...new Int16Array(e.pcm)]);
  const levels = () => messages.filter(e => e.type === 'level');
  return { processor, messages, rendered, context, send, run, input, levels };
}

test('audio levels cover the whole measurement interval; audit retains actual rendered samples', () => {
  const f = fixture();
  f.send({ type: 'audit_start', sessionId: 'test' });
  f.send({ type: 'play', pcm: new Int16Array(128 * 20).fill(16384).buffer });
  f.run(.5, 10); f.run(0, 30);
  assert.ok(Math.abs(f.levels()[0].rms - Math.sqrt(.125)) < .0001, 'not only the final silent block');
  assert.ok(Math.abs(f.levels()[0].durationMs - 2560 / 24) < .001);
  assert.ok(Math.abs(f.levels()[0].endTime * 1000 - f.levels()[0].durationMs) < .001);
  const playback = f.messages.filter(e => e.type === 'playback');
  assert.equal(playback.length, 40); assert.equal(playback[39].offsetSamples, 39 * 128);
  assert.deepEqual(playback.flatMap(e => [...new Int16Array(e.pcm)]), f.rendered.map(x => Math.round(x * 32768)));
  assert.equal(f.rendered.filter(x => x !== 0).length, 128 * 20, 'all samples survive the lead-in and final drain');
  f.send({ type: 'mute', muted: true }); f.run(.5);
  assert.equal(f.levels().at(-1).rms, 0); assert.equal(f.levels().at(-1).outputRms, 0);
});

test('the same whisper is blocked above the gate and reaches both Live and the Gantt below it', () => {
  const f = fixture();
  f.send({ type: 'audit_start', sessionId: 'test' });
  f.run(.004, 60);
  assert.ok(f.input().every(x => x === 0), 'only digital silence is sent when the whisper cannot open the gate');
  assert.ok(f.levels().every(e => e.rms === 0 && e.rawRms > 0));
  assert.ok([...new Int16Array(f.messages.find(e => e.type === 'playback').microphone)].every(x => x !== 0), 'audit retains pre-gate evidence');
  const timeline = new Timeline(0);
  const addLevel = e => timeline.add({ ...e, type: 'audio_level', inputRms: e.rms, at: e.endTime * 1000 });
  f.levels().forEach(addLevel);
  assert.equal(timeline.snapshot().items.filter(i => i.track === 'operator').length, 0);
  const before = f.input().length;
  f.send({ type: 'gate', threshold: .002 }); f.run(.004, 60);
  assert.ok(f.input().slice(before).every(x => x !== 0), 'same whisper now reaches the API');
  f.levels().slice(3).forEach(addLevel);
  assert.ok(timeline.snapshot().items.some(i => i.track === 'operator'));
  f.send({ type: 'gate', threshold: .008 }); f.run(.004, 60);
  assert.ok(f.input().slice(-480).every(x => x === 0), 'raising the threshold resets the old hold');
  assert.equal(f.levels().at(-1).rms, 0);
});

test('gate passes a 300 ms word tail, then closes; mute remains immediate', () => {
  const f = fixture(); f.send({ type: 'audit_start', sessionId: 'test' });
  f.run(.1, 15); const tailStart = f.input().length;
  f.run(.001, 45); // 240 ms after speech crossed the threshold
  assert.ok(f.input().slice(tailStart).every(x => x !== 0), 'soft word ending survives beyond the old 160 ms hold');
  f.run(.001, 30);
  const tail = f.input().slice(tailStart);
  const firstZeroMs = tail.indexOf(0) / 24;
  assert.ok(firstZeroMs >= 290 && firstZeroMs <= 310, `tail lasted ${firstZeroMs} ms`);
  assert.ok(f.input().slice(-480).every(x => x === 0));
  f.send({ type: 'gate', threshold: 0 }); f.run(.001, 15);
  assert.ok(f.input().slice(-480).every(x => x !== 0), 'zero disables the gate');
  f.send({ type: 'mute', muted: true }); f.run(.1, 15);
  assert.ok(f.input().slice(-480).every(x => x === 0));
  assert.ok([...new Int16Array(f.messages.filter(e => e.type === 'playback').at(-1).microphone)].every(x => x === 0));
});

test('80 ms playback lead-in joins jittered short chunks without losing, mixing or trimming samples', () => {
  const f = fixture();
  const chunks = [new Int16Array(960).fill(1000), new Int16Array(960).fill(-2000), new Int16Array(137).fill(3000)];
  f.send({ type: 'play', pcm: chunks[0].buffer }); f.run(0, 10); // 53 ms: would underrun without buffering
  f.send({ type: 'play', pcm: chunks[1].buffer }); f.run(0, 8);
  f.send({ type: 'play', pcm: chunks[2].buffer }); f.run(0, 30);
  const expected = chunks.flatMap(c => [...c]);
  const audible = f.rendered.map(x => Math.round(x * 32768));
  const start = audible.findIndex(x => x !== 0);
  assert.equal(start / 24, 80, 'bounded additional playback latency');
  assert.deepEqual(audible.slice(start, start + expected.length), expected, 'no gaps within the jittered burst, including the short final chunk');
  assert.ok(audible.slice(start + expected.length).every(x => x === 0), 'fully drained into silence');
  f.send({ type: 'play', pcm: new Int16Array([901, -902, 903]).buffer });
  const secondStart = f.rendered.length; f.run(0, 20);
  assert.deepEqual(f.rendered.slice(secondStart).filter(x => x !== 0).map(x => Math.round(x * 32768)), [901, -902, 903], 'a lone tiny clip never waits for a following chunk');
});
