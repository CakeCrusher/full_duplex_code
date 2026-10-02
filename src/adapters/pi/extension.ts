// The companion's extension: Pi loads it with -e for this run only. It forwards
// Pi's events to the bridge's /hook, as a command hook does for other agents,
// and hands each voice request to Pi over the bridge's /pi socket. It never
// influences Pi: every handler returns nothing and never waits on the bridge.
import { turnText } from './message.ts';

// The parts of Pi's extension API this file uses.
interface Context { sessionManager: { getSessionId(): string; getSessionFile(): string | undefined } }
interface PiApi {
  on(event: string, handler: (event: Record<string, unknown>, ctx: Context) => void): unknown;
  sendUserMessage(content: string, options?: { deliverAs?: 'steer' | 'followUp' }): void;
}

// What Pi did. Left out: each token of a message and each piece of partial tool
// output (the end events carry them whole), message_start, tool_call and
// tool_result (repeated by message_end and the tool_execution events), turn_end
// and agent_end (they repeat the whole context and every message), and raw
// provider traffic, whose headers can carry credentials.
export const OBSERVED_EVENTS = [
  'session_start', 'session_info_changed', 'session_tree', 'session_compact', 'session_compact_failed', 'session_shutdown',
  'model_select', 'thinking_level_select', 'mcp_servers_change', 'input', 'user_bash', 'agent_start', 'agent_settled',
  'message_end', 'tool_execution_start', 'tool_execution_end', 'ui_prompt_start', 'ui_prompt_end',
];

export default function companion(pi: PiApi) {
  const base = process.env.FD_BRIDGE_URL, token = process.env.FD_BRIDGE_TOKEN;
  if (!base || !token || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) return;

  // Events go out one at a time, in order. A handler only queues and returns.
  const queue: string[] = [];
  let sending = false;
  async function drain() {
    if (sending) return; sending = true;
    while (queue.length) {
      try { await fetch(`${base}/hook`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: queue[0], signal: AbortSignal.timeout(5000) }); } catch {}
      queue.shift();
    }
    sending = false;
  }
  for (const name of OBSERVED_EVENTS) {
    pi.on(name, (event, ctx) => {
      try {
        const session = { session_id: ctx.sessionManager.getSessionId(), ...(name === 'session_start' ? { session_file: ctx.sessionManager.getSessionFile() ?? null } : {}) };
        if (queue.length < 1000) queue.push(JSON.stringify({ ...event, type: name, ...session }));
        void drain();
      } catch {}
      if (name === 'session_start') { stopping = false; connect(); }
      if (name === 'session_shutdown') disconnect();
    });
  }

  // The request socket lives as long as the session: Pi replaces this runtime
  // when it switches sessions, and the new one connects again.
  const delivered = new Set<string>();
  let socket: WebSocket | undefined, retry: NodeJS.Timeout | undefined, stopping = false;
  function connect() {
    if (socket || stopping) return;
    const ws = socket = new WebSocket(`${base!.replace('http:', 'ws:')}/pi`, ['fd-voice', token!]);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'pi.ready', pid: process.pid }));
    ws.onmessage = message => {
      try {
        const event = JSON.parse(String(message.data));
        if (event.type !== 'pi.deliver' || typeof event.id !== 'string' || typeof event.content !== 'string') return;
        // A steer reaches a running turn; while Pi is idle, Pi starts a turn instead.
        if (!delivered.has(event.id)) { pi.sendUserMessage(turnText(event), { deliverAs: 'steer' }); delivered.add(event.id); }
        ws.send(JSON.stringify({ type: 'pi.sent', id: event.id }));
      } catch {}
    };
    ws.onclose = () => { if (socket === ws) socket = undefined; if (!stopping) retry = setTimeout(connect, 1000); };
    ws.onerror = () => {};
  }
  function disconnect() { stopping = true; clearTimeout(retry); socket?.close(); socket = undefined; }
}
