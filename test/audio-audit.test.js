import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AudioAudit } from '../src/audio-audit.js';

test('audit WAV files retain exact samples, missing playback time, private permissions and usable headers before close', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fd-audio-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const events=[],errors=[];const audit=new AudioAudit({dir,log:e=>events.push(e),onError:e=>errors.push(e)});t.after(()=>audit.close());
  const pcm=Buffer.from(new Int16Array([1000,-32768,32767,0]).buffer);
  audit.write('input',pcm);audit.write('output',pcm);
  audit.write('playback',pcm,{offsetSamples:0,at:1000});audit.write('playback',pcm,{offsetSamples:8,at:1001});
  const wav=fs.readFileSync(path.join(dir,'playback.wav'));
  assert.equal(wav.toString('ascii',0,4),'RIFF');assert.equal(wav.readUInt32LE(40),24);assert.equal(wav.readUInt32LE(24),24000);
  assert.deepEqual(wav.subarray(44,52),pcm);assert.deepEqual(wav.subarray(52,60),Buffer.alloc(8));assert.deepEqual(wav.subarray(60),pcm);
  assert.equal(fs.statSync(path.join(dir,'playback.wav')).mode&0o777,0o600);
  assert.equal(events.filter(e=>e.type==='audio.audit_gap').length,1);assert.deepEqual(errors,[]);
  audit.close();audit.write('playback',pcm);assert.equal(fs.statSync(path.join(dir,'playback.wav')).size,wav.length);
});

test('audio audit failures report loss of evidence without throwing into the live audio pipeline', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fd-audio-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const errors=[];const audit=new AudioAudit({dir,log:()=>{},onError:e=>errors.push(e)});
  audit.write('playback',Buffer.alloc(8),{offsetSamples:9999999});
  assert.equal(errors.length,1);assert.match(errors[0].message,/audit.*discontinuity/);assert.equal(audit.closed,true);
});
