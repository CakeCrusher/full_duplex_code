import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { Budget, RATE_PER_SECOND } from '../src/budget.js';
import { LiveSession } from '../src/live.js';

async function fixture(t, onCommand) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-live-'));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.on('listening', resolve));
  server.on('connection', ws => ws.on('message', raw => {
    const event = JSON.parse(raw);
    if (event.type === 'session.start') {
      assert.equal(event.session.model, 'gpt-live-1'); assert.equal(event.session.delegation.type, 'client');
      ws.send(JSON.stringify({ type: 'session.started', session: { id: 'test-live' } }));
    } else onCommand(ws, event);
  }));
  const budget = new Budget(path.join(dir, 'budget.json'));
  const live = new LiveSession({ apiKey: 'fake-test-key', budget, maxSeconds: 15, url: `ws://127.0.0.1:${server.address().port}` });
  t.after(async () => { live.abort('test cleanup'); for (const ws of server.clients) ws.terminate(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  return { live, budget };
}
test('final usage reconciles reservation and expected shutdown append errors do not surface as new faults', async t => {
  let pending;
  const { live, budget } = await fixture(t, (ws, e) => {
    if (e.type === 'session.thinking.append') pending = e.event_id;
    if (e.type === 'session.close') {
      ws.send(JSON.stringify({ type: 'error', error: { message: 'Session closed before context injection', client_event_id: pending } }));
      ws.send(JSON.stringify({ type: 'session.closed', usage: { seconds: 7 }, reason: 'close_requested', session: { id: 'test-live' } }));
    }
  });
  const faults = []; live.on('fault', e => faults.push(e.message));
  await live.start();
  const append = live.append('thinking', 'facts').catch(error => error.message);
  const result = await live.close();
  assert.match(await append, /closed/); assert.equal(result.finalized, true);
  assert.equal(budget.summary().committedUsd, 7 * RATE_PER_SECOND); assert.deepEqual(faults, []);
});
test('a transport loss preserves the full reservation without inventing final usage', async t => {
  const { live, budget } = await fixture(t, () => {});
  await live.start(); const reserved = budget.summary().committedUsd; live.ws.terminate();
  const result = await live.closed;
  assert.equal(result.finalized, false); assert.equal(budget.summary().committedUsd, reserved);
});
test('accelerated audio cannot outrun the reserved duration', async t => {
  const { live } = await fixture(t, (ws, event) => {
    if (event.type === 'session.close') ws.send(JSON.stringify({ type: 'session.closed', usage: { seconds: 0 }, reason: 'close_requested', session: { id: 'test-live' } }));
  });
  await live.start(); assert.throws(() => live.audio(Buffer.alloc(24000 * 2 * 4)), /real-time speed/);
  assert.equal((await live.closed).finalized, true);
});

test('a ledger failure closes without opening a connection or leaving shutdown pending', async t => {
  const { live, budget } = await fixture(t, () => {});
  budget.reserve(29990, 'existing usage');
  fs.writeFileSync(`${budget.file}.lock`, '');
  let closed = 0; live.on('closed', () => closed++);
  await assert.rejects(live.start(), /Usage ledger locked/);
  assert.equal(live.state, 'closed');
  assert.equal(live.ws, undefined);
  const result = await live.close();
  assert.equal(result.reserved, false);
  assert.equal(closed, 1);
  assert.equal(budget.summary().runs.length, 1, 'failed startup adds no reservation');
});

test('voice can start beyond the former spending cap and still records final usage', async t => {
  const { live, budget } = await fixture(t, (ws, event) => {
    if (event.type === 'session.close') ws.send(JSON.stringify({ type: 'session.closed', usage: { seconds: 7 }, reason: 'close_requested', session: { id: 'test-live' } }));
  });
  const old = budget.reserve(36000, 'previous session');
  budget.update(old, 36000, { finalized: true });
  await live.start();
  assert.equal(live.state, 'active');
  assert.equal((await live.close()).finalized, true);
  assert.ok(Math.abs(budget.summary().committedUsd - (30 + 7 * RATE_PER_SECOND)) < 1e-9);
});

test('missing credentials and closing an unstarted session both settle shutdown', async t => {
  const { live, budget } = await fixture(t, () => {});
  live.apiKey = '';
  await assert.rejects(live.start(), /OPENAI_API_KEY is missing/);
  assert.equal((await live.close()).reserved, false);
  const unstarted = new LiveSession({ apiKey: 'unused', budget });
  assert.equal((await unstarted.close()).reserved, false);
  assert.equal(unstarted.state, 'closed');
  assert.equal(budget.summary().runs.length, 0);
});

test('WebRTC negotiates media by HTTP and uses the sideband only for control and audit', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-live-native-'));
  let request, attachPath; const commands = [], received = [];
  const server = http.createServer(async (req,res) => {
    const chunks=[]; for await (const chunk of req) chunks.push(chunk);
    request=JSON.parse(Buffer.concat(chunks));
    assert.equal(req.headers.authorization,'Bearer fake-test-key');
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({session:{id:'native-id'},transport:{type:'webrtc',sdp:'answer-sdp'}}));
  });
  const sockets = new WebSocketServer({server});
  sockets.on('connection',(ws,req)=>{
    attachPath=req.url;
    ws.send(JSON.stringify({type:'session.started',session:{id:'native-id'}}));
    ws.send(JSON.stringify({type:'session.input_audio.append',audio:Buffer.alloc(960).toString('base64')}));
    ws.on('message',raw=>{
      const e=JSON.parse(raw); commands.push(e);
      if(e.type==='session.thinking.append')ws.send(JSON.stringify({type:'session.thinking.appended',client_event_id:e.event_id}));
      if(e.type==='session.close')ws.send(JSON.stringify({type:'session.closed',usage:{seconds:15},reason:'close_requested'}));
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const budget=new Budget(path.join(dir,'budget.json'));
  const live=new LiveSession({apiKey:'fake-test-key',budget,maxSeconds:20,url:`ws://127.0.0.1:${server.address().port}/v1/live/sessions`});
  t.after(async()=>{live.abort('cleanup');for(const ws of sockets.clients)ws.terminate();sockets.close();await new Promise(resolve=>server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});});
  let answer; live.on('answer',sdp=>answer=sdp); live.on('event',e=>received.push(e));
  await live.start('offer-sdp');
  assert.deepEqual(request.transport,{type:'webrtc',sdp:'offer-sdp'});
  assert.equal(request.session.audio.format,undefined,'WebRTC negotiates its own codec');
  assert.equal(request.session.store,false);
  assert.equal(answer,'answer-sdp');
  assert.equal(attachPath,'/v1/live/sessions/native-id/attach');
  assert.throws(()=>live.audio(Buffer.alloc(960)),/media track/);
  await live.append('thinking','An observation');
  assert.ok(received.some(e=>e.type==='session.input_audio.append'),'server can audit media reflected by the API');
  assert.deepEqual(commands.map(e=>e.type),['session.thinking.append'],'no second session.start or audio stream');
  assert.equal((await live.close()).finalized,true);
  assert.equal(budget.summary().committedUsd,15*RATE_PER_SECOND);
});

test('canceling WebRTC startup aborts the HTTP request and permits clean shutdown', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fd-live-cancel-'));
  let arrived; const requested=new Promise(resolve=>arrived=resolve);
  const server=http.createServer(()=>arrived());
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const live=new LiveSession({apiKey:'fake',budget:new Budget(path.join(dir,'budget.json')),url:`ws://127.0.0.1:${server.address().port}`});
  t.after(()=>{live.abort('cleanup');server.closeAllConnections();server.close();fs.rmSync(dir,{recursive:true,force:true});});
  const starting=live.start('offer');
  const rejected=assert.rejects(starting,/abort/i);
  await requested;
  assert.equal((await live.close('operator canceled')).finalized,false);
  await rejected;
  assert.equal(live.state,'closed');
  assert.equal(live.ws,undefined);
});

test('an active voice connection has no automatic duration cutoff', async t => {
  const { live } = await fixture(t, () => {});
  await live.start();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.mock.timers.tick(4 * 60 * 60 * 1000);
  assert.equal(live.state, 'active');
  assert.equal(live.durationTimer, undefined);
  assert.equal(live.hardTimer, undefined);
});
