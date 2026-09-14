#!/usr/bin/env node
// Small, display-preserving hook relay. Command hooks cover SessionStart and
// MessageDisplay on releases where HTTP hooks support only some lifecycle events.
import { MAX_HOOK_BYTES } from './context.js';
const url = process.argv[2];
const token = process.env.FD_BRIDGE_TOKEN;
try {
  if (!token || !/^http:\/\/127\.0\.0\.1:\d+\/hook$/.test(url)) throw new Error('Missing local voice hook configuration');
  let size = 0; const buffers = [];
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_HOOK_BYTES) throw new Error('Hook exceeds the 32 MiB transport limit');
    buffers.push(chunk);
  }
  const input = Buffer.concat(buffers).toString('utf8');
  const event = JSON.parse(input);
  const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(event), signal: AbortSignal.timeout(1500) });
  if (!response.ok) throw new Error(`Voice hook returned HTTP ${response.status}`);
} catch (error) { process.stderr.write(`Voice observation: ${error.message}\n`); }
// No displayContent, permission decision, continuation, or task feedback.
process.stdout.write('{}\n');
