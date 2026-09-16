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
  processor.port.onmessage({ data: { type: 'audit_start', sessionId: 'test' } });
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
  const playback = messages.filter(e => e.type === 'playback');
  assert.equal(playback.length, 20); assert.equal(playback[19].offsetSamples, 19 * 128);
  assert.ok([...new Int16Array(playback[0].pcm)].every(sample => sample === 16384));
  processor.port.onmessage({ data: { type: 'mute', muted: true } });
  for (let i = 0; i < 20; i++) processor.process([[new Float32Array(128).fill(.5)]], [[new Float32Array(128)]]);
  const muted = messages.filter(e => e.type === 'level').at(-1);
  assert.equal(muted.rms, 0); assert.equal(muted.outputRms, 0);
  assert.ok([...new Int16Array(messages.filter(e => e.type === 'playback').at(-1).pcm)].every(sample => sample === 0));
});

test('noise gate silences quiet input, preserves word tails, can be disabled, and audits pre-gate audio', () => {
  let Processor;const messages=[];
  const context=vm.createContext({AudioWorkletProcessor:class{constructor(){this.port={postMessage:e=>messages.push(e)};}},registerProcessor:(_,type)=>{Processor=type;},sampleRate:24000,currentTime:0});
  vm.runInContext(fs.readFileSync(new URL('../web/audio-worklet.js',import.meta.url),'utf8'),context);
  const p=new Processor();p.port.onmessage({data:{type:'audit_start',sessionId:'test'}});
  const run=(value,blocks=30)=>{for(let i=0;i<blocks;i++){p.process([[new Float32Array(128).fill(value)]],[[new Float32Array(128)]]);context.currentTime+=128/24000;}};
  run(.001);
  assert.ok(messages.filter(e=>e.type==='input').every(e=>[...new Int16Array(e.pcm)].every(x=>x===0)),'quiet noise is not sent to Live');
  assert.ok([...new Int16Array(messages.find(e=>e.type==='playback').microphone)].every(x=>x!==0),'audit retains quiet pre-gate audio');
  run(.1,5);run(.001,5);
  assert.ok([...new Int16Array(messages.filter(e=>e.type==='input').at(-1).pcm)].some(x=>x!==0),'quiet word endings survive the hold');
  run(.001,40);
  assert.ok([...new Int16Array(messages.filter(e=>e.type==='input').at(-1).pcm)].every(x=>x===0),'gate closes after hold');
  p.port.onmessage({data:{type:'gate',threshold:0}});run(.001);
  assert.ok([...new Int16Array(messages.filter(e=>e.type==='input').at(-1).pcm)].every(x=>x!==0),'zero disables the gate');
  p.port.onmessage({data:{type:'mute',muted:true}});run(.1);
  assert.ok([...new Int16Array(messages.filter(e=>e.type==='playback').at(-1).microphone)].every(x=>x===0),'mute also silences the pre-gate audit');
});
