import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import * as pty from 'node-pty';
import WebSocket from 'ws';
import { Harness } from '../src/server.js';
import { claudeArgs } from '../src/agent.js';

export const root = fileURLToPath(new URL('..', import.meta.url));
try { process.loadEnvFile(path.join(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function until(check, { timeout = 45000, label = 'condition' } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const value = check(); if (value) return value; await delay(100); }
  throw new Error(`Timed out waiting for ${label}`);
}
export async function startTestHarness(label, options = {}) {
  const sessionId = options.sessionId ?? randomUUID(); const runDir = path.join(root, '.runs', `${label}-${Date.now()}`);
  const cwd = options.cwd ?? path.join(runDir, 'workspace'); fs.mkdirSync(cwd, { recursive: true });
  spawnSync('git', ['init', '--quiet'], { cwd });
  const harness = await new Harness({ root, runDir, cwd, sessionId, apiKey: process.env.OPENAI_API_KEY, maxSeconds: options.maxSeconds ?? 240, ...options }).start();
  const env = { ...process.env, FD_BRIDGE_TOKEN: harness.channelToken, TERM: 'xterm-256color' }; delete env.OPENAI_API_KEY;
  // The test agent only needs local file work and Node test commands. The headed
  // production launcher retains the operator's ordinary Claude permissions.
  const args = claudeArgs({ config: harness.config, sessionId, resume: Boolean(options.resume), extraArgs: ['--strict-mcp-config', '--no-chrome', '--debug-file', path.join(runDir, 'debug.log'), '--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Write,Edit,Bash,mcp__voice__acknowledge,mcp__voice__reply', '--append-system-prompt', 'This is an isolated local voice-harness test workspace. Keep all requested files and commands inside this working directory. There is no need to inspect parent directories. Complete the requested tiny programs and tests without asking about routine implementation choices.'] });
  // node-pty's macOS prebuild currently ships spawn-helper without its executable
  // bit. Repair only this installed test dependency, when needed.
  const helper = path.join(root, 'node_modules/node-pty/prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
  if (fs.existsSync(helper)) fs.chmodSync(helper, fs.statSync(helper).mode | 0o111);
  let terminal;
  try { terminal = pty.spawn('claude', args, { name: 'xterm-256color', cols: 120, rows: 35, cwd, env }); }
  catch (error) { await harness.close(); throw error; }
  let raw = ''; let trust = false; let development = false; let exited = false;
  terminal.onData(data => {
    fs.appendFileSync(path.join(runDir, 'terminal.log'), data);
    raw = (raw + stripVTControlCharacters(data)).slice(-24000);
    const compact = raw.replace(/[^A-Za-z]/g, '');
    if (!trust && compact.includes('YesItrustthisfolder')) {
      trust = true;
      setTimeout(() => { if (!exited) { terminal.write('\x1b[B'); setTimeout(() => { if (!exited) terminal.write('\r'); }, 200); } }, 300);
    } else if (!development && compact.includes('WARNINGLoadingdevelopmentchannels') && compact.includes('Iamusingthisforlocaldevelopment')) {
      development = true; setTimeout(() => { if (!exited) terminal.write('\r'); }, 300);
    }
  });
  terminal.onExit(() => { exited = true; });
  console.log('Run:', runDir);
  // A resumed session can start processing recovered work before its channel
  // connects. Working is a healthy ready state; requiring idle loses that case.
  try { await until(() => harness.channelReady && !['starting','exited'].includes(harness.observer.state), { label: 'headed Claude and hooks' }); }
  catch (error) { terminal.kill(); await harness.close(); throw error; }
  return { harness, terminal, runDir, cwd, isAlive: () => !exited, async close() {
    await harness.close(); if (!exited) terminal.kill('SIGTERM'); await delay(500);
  } };
}

export function synthesize(name, text) {
  const dir = path.join(root, '.cache/audio'); fs.mkdirSync(dir, { recursive: true });
  const wav = path.join(dir, `${name}.wav`); const pcm = path.join(dir, `${name}.pcm`);
  fs.writeFileSync(path.join(dir, `${name}.txt`), text);
  const voice = spawnSync('say', ['-v', 'Samantha', '-r', '170', '-o', path.join(dir, `${name}.aiff`), text], { encoding: 'utf8' });
  if (voice.status !== 0) throw new Error('macOS say failed: ' + voice.stderr);
  for (const [file, format] of [[wav, []], [pcm, ['-f', 's16le']]]) {
    const converted = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', path.join(dir, `${name}.aiff`), '-ar', '24000', '-ac', '1', ...format, file], { encoding: 'utf8' });
    if (converted.status !== 0) throw new Error(converted.stderr);
  }
  return { pcm: fs.readFileSync(pcm), wav, text };
}

export async function connectTestVoice(harness) {
  const ws = new WebSocket(harness.baseUrl.replace('http:', 'ws:') + '/voice', { headers: { Authorization: `Bearer ${harness.browserToken}` } });
  const events = []; const outputs = []; let file = null; let offset = 0; let resolvePlayback;
  ws.on('message', (data, binary) => {
    if (binary) outputs.push(Buffer.from(data));
    else { const e = JSON.parse(data.toString()); events.push({ at: Date.now(), ...e }); if (e.type === 'caption') process.stdout.write(e.text); if (e.type === 'fault') console.error('\nFAULT:', e.message); }
  });
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  const timer = setInterval(() => {
    let packet = Buffer.alloc(960);
    if (file) {
      const part = file.subarray(offset, offset + 960); part.copy(packet); offset += part.length;
      if (offset >= file.length) { file = null; resolvePlayback?.(); }
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(packet);
  }, 20);
  ws.send(JSON.stringify({ type: 'start' }));
  await until(() => events.find(e => e.type === 'voice_started'), { label: 'Live startup' });
  return {
    events, ws,
    async speak(fixture) {
      if (file) throw new Error('Test audio is already playing');
      console.log('\n\nINPUT:', fixture.text);
      harness.log({ type: 'test.audio_started', text: fixture.text });
      await new Promise(resolve => { file = fixture.pcm; offset = 0; resolvePlayback = resolve; });
      harness.log({ type: 'test.audio_ended', text: fixture.text });
    },
    async close() {
      ws.send(JSON.stringify({ type: 'stop' }));
      await until(() => events.find(e => e.type === 'voice_closed'), { timeout: 20000, label: 'final Live usage' }).catch(error => console.error(error.message));
      clearInterval(timer); ws.close();
      fs.writeFileSync(path.join(harness.runDir, 'voice-events.json'), JSON.stringify(events, null, 2));
      fs.writeFileSync(path.join(harness.runDir, 'output.pcm'), Buffer.concat(outputs));
      spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', path.join(harness.runDir, 'output.pcm'), path.join(harness.runDir, 'output.wav')]);
    },
  };
}
