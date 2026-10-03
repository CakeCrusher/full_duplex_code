import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import * as pty from 'node-pty';
import WebSocket from 'ws';
import { Harness, type HarnessOptions } from '../src/core/bridge.ts';
import { claude } from '../src/adapters/claude/index.ts';
import { codex } from '../src/adapters/codex/index.ts';
import { pi } from '../src/adapters/pi/index.ts';

export const root = fileURLToPath(new URL('..', import.meta.url));
try { process.loadEnvFile(path.join(root, '.env')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
export const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export async function until<T>(check: () => T, { timeout = 45000, label = 'condition' } = {}): Promise<NonNullable<T>> {
  const start = Date.now();
  while (Date.now() - start < timeout) { const value = check(); if (value) return value as NonNullable<T>; await delay(100); }
  throw new Error(`Timed out waiting for ${label}`);
}
export async function startTestHarness(label: string, { resume = false, ...options }: Partial<HarnessOptions> & { resume?: boolean } = {}) {
  const sessionId = options.sessionId ?? randomUUID(); const runDir = path.join(root, '.runs', `${label}-${Date.now()}`);
  const cwd = options.cwd ?? path.join(runDir, 'workspace'); fs.mkdirSync(cwd, { recursive: true });
  spawnSync('git', ['init', '--quiet'], { cwd });
  // The test agent only needs local file work and Node test commands. The headed
  // production launcher retains the operator's ordinary Claude permissions.
  const agentArgs = [...(resume ? ['--resume', sessionId] : []), '--setting-sources', '', '--strict-mcp-config', '--no-chrome', '--debug-file', path.join(runDir, 'debug.log'), '--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Write,Edit,Bash', '--append-system-prompt', `This is an isolated local voice-harness test workspace. The working directory is exactly ${cwd}. Use relative paths for commands and keep files here; do not infer paths from the scratchpad directory name. There is no need to inspect parent directories. Complete the requested tiny programs and tests without asking about routine implementation choices.`];
  const harness = await new Harness({ agent: claude, root, runDir, cwd, sessionId, apiKey: process.env.OPENAI_API_KEY!, agentArgs, ...options }).start();
  const launch = harness.agentLaunch!;
  const env: Record<string, string> = { ...process.env as Record<string, string>, ...launch.env, TERM: 'xterm-256color' }; delete env.OPENAI_API_KEY;
  // Run inside Claude Code, the tests would otherwise start a child of that
  // session, which never saves its own transcript (so --resume finds nothing).
  for (const name of Object.keys(env)) if (/^CLAUDE(CODE$|_CODE_|_PID$|_EFFORT$)/.test(name)) delete env[name];
  const args = launch.args;
  // node-pty's macOS prebuild currently ships spawn-helper without its executable
  // bit. Repair only this installed test dependency, when needed.
  const helper = path.join(root, 'node_modules/node-pty/prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
  if (fs.existsSync(helper)) fs.chmodSync(helper, fs.statSync(helper).mode | 0o111);
  let terminal: pty.IPty;
  try { terminal = pty.spawn(launch.command, args, { name: 'xterm-256color', cols: 120, rows: 35, cwd, env }); }
  catch (error) { await harness.close(); throw error; }
  let raw = ''; let trust = false; let development = false; let exited = false; let confirming: NodeJS.Timeout | undefined;
  terminal.onData(data => {
    fs.appendFileSync(path.join(runDir, 'terminal.log'), data);
    // Strip the accumulated output: an escape sequence split across two chunks
    // would otherwise leave stray letters inside the prompt text we look for.
    raw = (raw + data).slice(-48000);
    const compact = stripVTControlCharacters(raw).replace(/[^A-Za-z]/g, '');
    if (!trust && compact.includes('YesItrustthisfolder')) {
      trust = true;
      setTimeout(() => { if (!exited) { terminal.write('\x1b[B'); setTimeout(() => { if (!exited) terminal.write('\r'); }, 200); } }, 300);
    } else if (!development && compact.includes('WARNINGLoadingdevelopmentchannels') && compact.includes('Iamusingthisforlocaldevelopment')) {
      // Choose "1. I am using this for local development". Claude can draw the
      // menu before it accepts keys, so confirm until its first hook arrives.
      development = true; let attempts = 0;
      confirming = setInterval(() => {
        if (exited || harness.observer.state !== 'starting' || ++attempts > 8) { clearInterval(confirming); return; }
        terminal.write('\r');
      }, 1000);
    }
  });
  terminal.onExit(() => { exited = true; clearInterval(confirming); });
  console.log('Run:', runDir);
  // A resumed session can start processing recovered work before its channel
  // connects. Working is a healthy ready state; requiring idle loses that case.
  try { await until(() => harness.agentReady && !['starting','exited'].includes(harness.observer.state), { label: 'headed Claude and hooks' }); }
  catch (error) { terminal.kill(); await harness.close(); throw error; }
  return { harness, terminal, runDir, cwd, isAlive: () => !exited, async close() {
    await harness.close(); if (!exited) terminal.kill('SIGTERM'); await delay(500);
  } };
}

// Real Codex in a terminal, attached to the companion's app server: by default
// a new session that needs no approvals, with a first message or none.
export async function startCodexTestHarness(label: string, { prompt, args, cwd }: { prompt?: string; args?: string[]; cwd?: string } = {}) {
  const runDir = path.join(root, '.runs', `${label}-${Date.now()}`);
  if (!cwd) { cwd = path.join(runDir, 'workspace'); fs.mkdirSync(cwd, { recursive: true }); spawnSync('git', ['init', '--quiet'], { cwd }); }
  const agentArgs = args ?? ['--no-alt-screen', '-s', 'workspace-write', '-a', 'never', ...(prompt === undefined ? [] : [prompt])];
  const harness = await new Harness({ agent: codex, root, runDir, cwd, apiKey: process.env.OPENAI_API_KEY!, agentArgs }).start();
  const launch = harness.agentLaunch!;
  const env: Record<string, string> = { ...process.env as Record<string, string>, ...launch.env, TERM: 'xterm-256color' }; delete env.OPENAI_API_KEY;
  const helper = path.join(root, 'node_modules/node-pty/prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
  if (fs.existsSync(helper)) fs.chmodSync(helper, fs.statSync(helper).mode | 0o111);
  const terminal = pty.spawn(launch.command, launch.args, { name: 'xterm-256color', cols: 140, rows: 45, cwd, env });
  let raw = '', trust = false, exited = false;
  terminal.onData(data => {
    fs.appendFileSync(path.join(runDir, 'terminal.log'), data);
    raw = (raw + data).slice(-48000);
    if (!trust && /trustthecontents|Doyoutrust/i.test(stripVTControlCharacters(raw).replace(/\s/g, ''))) { trust = true; setTimeout(() => { if (!exited) terminal.write('\r'); }, 300); }
  });
  terminal.onExit(() => { exited = true; });
  console.log('Run:', runDir);
  try { await until(() => harness.agentReady, { label: 'Codex session attached', timeout: 90000 }); }
  catch (error) { terminal.kill(); await harness.close(); throw error; }
  return { harness, terminal, runDir, cwd, isAlive: () => !exited, async close() {
    if (!exited) { terminal.write('\x03'); await delay(400); terminal.write('\x03'); await delay(800); }
    if (!exited) terminal.kill('SIGTERM');
    await harness.close(); await delay(300);
  } };
}

export interface Fixture { pcm: Buffer; wav: string; text: string }
export function synthesize(name: string, text: string): Fixture {
  const dir = path.join(root, '.cache/audio'); fs.mkdirSync(dir, { recursive: true });
  const wav = path.join(dir, `${name}.wav`); const pcm = path.join(dir, `${name}.pcm`);
  fs.writeFileSync(path.join(dir, `${name}.txt`), text);
  const voice = spawnSync('say', ['-v', 'Samantha', '-r', '170', '-o', path.join(dir, `${name}.aiff`), text], { encoding: 'utf8' });
  if (voice.status !== 0) throw new Error('macOS say failed: ' + voice.stderr);
  for (const [file, format] of [[wav, []], [pcm, ['-f', 's16le']]] as [string, string[]][]) {
    const converted = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', path.join(dir, `${name}.aiff`), '-ar', '24000', '-ac', '1', ...format, file], { encoding: 'utf8' });
    if (converted.status !== 0) throw new Error(converted.stderr);
  }
  return { pcm: fs.readFileSync(pcm), wav, text };
}

export async function connectTestVoice(harness: Harness) {
  return connectVoice({ baseUrl: harness.baseUrl, browserToken: harness.browserToken, runDir: harness.runDir, log: event => harness.log(event) });
}

// The page's voice connection, to any running bridge: synthesized speech in, Live's audio and events out.
export async function connectVoice({ baseUrl, browserToken, runDir, log = () => {} }: { baseUrl: string; browserToken: string; runDir: string; log?: (event: Record<string, unknown>) => void }) {
  const ws = new WebSocket(baseUrl.replace('http:', 'ws:') + '/voice', { headers: { Authorization: `Bearer ${browserToken}` } });
  const events: any[] = []; const outputs: Buffer[] = []; let file: Buffer | null = null; let offset = 0; let resolvePlayback: (() => void) | undefined;
  ws.on('message', (data, binary) => {
    if (binary) outputs.push(Buffer.from(data as Buffer));
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
    async speak(fixture: Fixture) {
      if (file) throw new Error('Test audio is already playing');
      console.log('\n\nINPUT:', fixture.text);
      log({ type: 'test.audio_started', text: fixture.text });
      await new Promise<void>(resolve => { file = fixture.pcm; offset = 0; resolvePlayback = resolve; });
      log({ type: 'test.audio_ended', text: fixture.text });
    },
    async close() {
      ws.send(JSON.stringify({ type: 'stop' }));
      await until(() => events.find(e => e.type === 'voice_closed'), { timeout: 20000, label: 'final Live usage' }).catch(error => console.error(error.message));
      clearInterval(timer); ws.close();
      fs.writeFileSync(path.join(runDir, 'voice-events.json'), JSON.stringify(events, null, 2));
      fs.writeFileSync(path.join(runDir, 'output.pcm'), Buffer.concat(outputs));
      spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', path.join(runDir, 'output.pcm'), path.join(runDir, 'output.wav')]);
    },
  };
}

// Real Pi in a terminal, with the companion's extension. Its sessions are kept in
// the run folder, apart from the operator's. PI_BIN runs Pi from a checkout when
// no pi is on the PATH: a pi command that runs it is put first on the PATH.
export async function startPiTestHarness(label: string, { args = [], cwd, sessionDir }: { args?: string[]; cwd?: string; sessionDir?: string } = {}) {
  const runDir = path.join(root, '.runs', `${label}-${Date.now()}`);
  if (!cwd) { cwd = path.join(runDir, 'workspace'); fs.mkdirSync(cwd, { recursive: true }); spawnSync('git', ['init', '--quiet'], { cwd }); }
  sessionDir ??= path.join(runDir, 'pi-sessions');
  const agentArgs = ['--session-dir', sessionDir, '--thinking', 'low', ...args];
  const harness = await new Harness({ agent: pi, root, runDir, cwd, apiKey: process.env.OPENAI_API_KEY!, agentArgs }).start();
  const launch = harness.agentLaunch!;
  const env: Record<string, string> = { ...process.env as Record<string, string>, ...launch.env, TERM: 'xterm-256color' }; delete env.OPENAI_API_KEY;
  if (process.env.PI_BIN) {
    const bin = path.join(runDir, 'bin'); fs.mkdirSync(bin, { recursive: true });
    // A wrapper, not a link: a checkout's script finds its files from its own path.
    fs.writeFileSync(path.join(bin, 'pi'), `#!/bin/sh\nexec '${process.env.PI_BIN.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o755 });
    env.PATH = `${bin}:${env.PATH}`;
  }
  const helper = path.join(root, 'node_modules/node-pty/prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
  if (fs.existsSync(helper)) fs.chmodSync(helper, fs.statSync(helper).mode | 0o111);
  const terminal = pty.spawn(launch.command, launch.args, { name: 'xterm-256color', cols: 140, rows: 45, cwd, env });
  let exited = false;
  terminal.onData(data => fs.appendFileSync(path.join(runDir, 'terminal.log'), data));
  terminal.onExit(() => { exited = true; });
  console.log('Run:', runDir);
  try { await until(() => harness.agentReady && harness.observer.state !== 'starting', { label: "Pi's companion extension connected", timeout: 60000 }); }
  catch (error) { terminal.kill(); await harness.close(); throw error; }
  return { harness, terminal, runDir, cwd, sessionDir, isAlive: () => !exited, async close() {
    // Pi quits on Ctrl-C twice, or Ctrl-D on an empty editor.
    if (!exited) { terminal.write('\x04'); await delay(800); }
    if (!exited) { terminal.write('\x03'); await delay(300); terminal.write('\x03'); await delay(800); }
    if (!exited) terminal.kill('SIGTERM');
    await harness.close(); await delay(300);
  } };
}

