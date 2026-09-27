#!/usr/bin/env node
// The command hook: the agent runs this once per event with the event JSON on
// stdin. It forwards the event to the bridge's /hook, unchanged, and never
// influences the agent: no display content, permission decision or continuation.
import { MAX_HOOK_BYTES } from './limits.ts';
const url = process.argv[2];
const token = process.env.FD_BRIDGE_TOKEN;
try {
  if (!token || !/^http:\/\/127\.0\.0\.1:\d+\/hook$/.test(url)) throw new Error('Missing local voice hook configuration');
  let size = 0; const buffers: Buffer[] = [];
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_HOOK_BYTES) throw new Error('Hook exceeds the 32 MiB transport limit');
    buffers.push(chunk);
  }
  const input = Buffer.concat(buffers).toString('utf8');
  const event = JSON.parse(input);
  const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(event), signal: AbortSignal.timeout(1500) });
  if (!response.ok) throw new Error(`Voice hook returned HTTP ${response.status}`);
} catch (error) { process.stderr.write(`Voice observation: ${(error as Error).message}\n`); }
process.stdout.write('{}\n');
