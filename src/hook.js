#!/usr/bin/env node
// Small, display-preserving hook relay. Command hooks cover SessionStart and
// MessageDisplay on releases where HTTP hooks support only some lifecycle events.
const url = process.argv[2];
const token = process.env.FD_BRIDGE_TOKEN;
try {
  if (!token || !/^http:\/\/127\.0\.0\.1:\d+\/hook$/.test(url)) throw new Error('Missing local voice hook configuration');
  let input = ''; for await (const chunk of process.stdin) { input += chunk; if (input.length > 4 * 1024 * 1024) throw new Error('Oversized hook input'); }
  const event = JSON.parse(input);
  const safe = {};
  for (const key of ['session_id', 'transcript_path', 'hook_event_name', 'agent_id', 'turn_id', 'message_id', 'prompt', 'index', 'final', 'delta', 'last_assistant_message', 'tool_name', 'notification_type']) if (event[key] !== undefined) safe[key] = event[key];
  if (event.background_tasks) safe.background_tasks = event.background_tasks.map(t => ({ id: t.id, status: t.status }));
  const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(safe), signal: AbortSignal.timeout(1000) });
  if (!response.ok) throw new Error(`Voice hook returned HTTP ${response.status}`);
} catch (error) { process.stderr.write(`Voice observation: ${error.message}\n`); }
// No displayContent, permission decision, continuation, or task feedback.
process.stdout.write('{}\n');
