import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { Timeline } from '../src/timeline.js';

function fixture() {
  let Processor; const messages = [], rendered = [], transmitted = []; let remote = [];
  const context = vm.createContext({ AudioWorkletProcessor: class { constructor() { this.port = { postMessage: e => messages.push(e) }; } },
    registerProcessor: (_name, type) => { Processor = type; }, sampleRate: 24000, currentTime: 0 });
  vm.runInContext(fs.readFileSync(new URL('../web/audio-worklet.js', import.meta.url), 'utf8'), context);
  const processor = new Processor();
  const send = data => { if (data.type==='play') remote.push(...new Int16Array(data.pcm)); else processor.port.onmessage({ data }); };
  const run = (value = 0, blocks = 20) => {
    for (let i = 0; i < blocks; i++) {
      const output = new Float32Array(128);
      const outgoing = new Float32Array(128);
      const incoming = Float32Array.from({length:128},()=> (remote.shift()??0)/32768);
      processor.process([[new Float32Array(128).fill(value)],[incoming]], [[outgoing],[output]]);
      transmitted.push(...outgoing.map(x=>Math.round(x*32768)));
      rendered.push(...output); context.currentTime += 128 / 24000;
    }
  };
  const input = () => transmitted;
  const levels = () => messages.filter(e => e.type === 'level');
  return { processor, messages, rendered, context, send, run, input, levels };
}

test('audio levels cover the whole measurement interval; audit retains actual rendered samples', () => {
  const f = fixture();
  f.send({ type: 'audit_start', sessionId: 'test' });
  f.send({ type: 'play', pcm: new Int16Array(128 * 20).fill(16384).buffer });
  f.run(.5, 10); f.run(0, 30);
  const sent = f.input().slice(0, 128 * 20);
  const measured = Math.sqrt(sent.reduce((sum, x) => sum + (x / 32768) ** 2, 0) / sent.length);
  assert.ok(measured > .3, 'the measurement includes the earlier spoken blocks');
  assert.ok(Math.abs(f.levels()[0].rms - measured) < .0001, 'not only the final silent block');
  assert.ok(Math.abs(f.levels()[0].durationMs - 2560 / 24) < .001);
  assert.ok(Math.abs(f.levels()[0].endTime * 1000 - f.levels()[0].durationMs) < .001);
  const playback = f.messages.filter(e => e.type === 'playback');
  assert.equal(playback.length, 40); assert.equal(playback[39].offsetSamples, 39 * 128);
  assert.deepEqual(playback.flatMap(e => [...new Int16Array(e.pcm)]), f.rendered.map(x => Math.round(x * 32768)));
  assert.equal(f.rendered.filter(x => x !== 0).length, 128 * 20, 'all decoded samples are rendered');
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

test('accepted quiet speech is boosted without changing gate decisions or clipping loud speech', () => {
  const f = fixture(); f.send({ type: 'audit_start', sessionId: 'gain' });
  f.run(.004, 20);
  assert.ok(f.input().every(x => x === 0), 'boost cannot lift noise over the threshold');
  f.run(.02, 20);
  assert.ok(Math.abs(f.levels().at(-1).rms - .08) < .0001, 'quiet accepted speech reaches Live at a useful level');
  assert.ok(Math.abs(f.levels().at(-1).rawRms - .02) < .0001, 'the gate meter still reports the original microphone');
  const raw = new Int16Array(f.messages.filter(e => e.type === 'playback').at(-1).microphone);
  assert.ok(Math.abs(raw[0] / 32768 - .02) < .0001, 'pre-gate audit remains unmodified');
  f.run(1, 1); f.run(-1, 1);
  assert.ok(f.input().slice(-256).every(x => Math.abs(x / 32768) <= .9001), 'both polarities retain headroom');
  f.run(.02, 1); const immediate = Math.abs(f.input().at(-1) / 32768);
  f.run(.02, 180); const recovered = Math.abs(f.input().at(-1) / 32768);
  assert.ok(immediate < .025, 'gain recovers gradually after a loud transient');
  assert.ok(recovered > .079 && recovered <= .0801);
});

test('native media gates the outgoing track and passes incoming speech unchanged, simultaneously', () => {
  let Processor; const messages = [];
  const context = vm.createContext({ AudioWorkletProcessor: class { constructor() { this.port = { postMessage: e => messages.push(e) }; } },
    registerProcessor: (_name, type) => { Processor = type; }, sampleRate: 24000, currentTime: 0 });
  vm.runInContext(fs.readFileSync(new URL('../web/audio-worklet.js', import.meta.url), 'utf8'), context);
  const processor = new Processor();
  processor.port.onmessage({data:{type:'audit_start',sessionId:'native-test'}});
  const incoming = Float32Array.from({length:128}, (_,i)=>Math.sin(i*.2)*.25);
  const outgoing = new Float32Array(128), speaker = new Float32Array(128);
  const step = amplitude => processor.process([[new Float32Array(128).fill(amplitude)],[incoming]], [[outgoing],[speaker]]);
  step(.004);
  assert.ok(outgoing.every(x=>x===0), 'subthreshold whisper never reaches the media track');
  assert.deepEqual(speaker,incoming, 'incoming speech is neither queued nor spliced');
  processor.port.onmessage({data:{type:'gate',threshold:.002}});
  step(.004);
  assert.ok(outgoing.every(x=>x>0), 'lowering the gate passes the same whisper');
  assert.deepEqual(speaker,incoming, 'speaking and listening happen simultaneously');
  processor.port.onmessage({data:{type:'mute',muted:true}});
  step(.5);
  assert.ok(outgoing.every(x=>x===0));
  assert.deepEqual(speaker,incoming, 'mute only affects the microphone');
  assert.equal(messages.filter(e=>e.type==='input').length,0, 'no second microphone stream over the control socket');
  assert.deepEqual([...new Int16Array(messages.at(-1).pcm)], [...incoming].map(x=>Math.round(x*32768)), 'audit measures the speaker track');
});
