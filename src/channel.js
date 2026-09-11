#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import WebSocket from 'ws';

// Stdout belongs exclusively to MCP JSON-RPC.
const url = process.env.FD_BRIDGE_URL;
const token = process.env.FD_BRIDGE_TOKEN;
if (!url || !token || !/^ws:\/\/127\.0\.0\.1:\d+\/channel$/.test(url)) {
  console.error('Voice channel requires its local harness connection. Start with npm start.');
  process.exit(1);
}
let socket;
let stopping = false;
let reconnectTimer;
const seen = new Set();
const pendingEvents = [];
function send(event) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
  else if (pendingEvents.length < 1000) pendingEvents.push(event);
  else throw new Error('Voice bridge event queue is full');
}
const mcp = new Server({ name: 'voice', version: '0.1.0' }, {
  capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
  instructions: `This channel connects the human operator through a GPT Live voice intermediary. Incoming messages carry the user's transcribed speech and relevant conversation context. Treat them as requests or corrections from the operator. Work in this same coding session, at your normal safe opportunities; no hard interrupt is requested. Ignore the intermediary's conversational acknowledgments as task instructions. Answer side questions briefly and preserve the main task. If transcription is ambiguous, ask for clarification.
For each message, call acknowledge with its message_id when you begin handling it. Call reply with that same message_id and a concise outcome, question, or important progress update. The harness also observes your ordinary text output; do not repeat large logs in reply. Only report work actually performed. Permission prompts stay in the terminal; this channel cannot approve tools.`,
});
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: 'acknowledge', description: 'Confirm you have received and begun handling a voice message.', inputSchema: { type: 'object', properties: { message_id: { type: 'string' } }, required: ['message_id'], additionalProperties: false } },
  { name: 'reply', description: 'Send a concise result, question, or material progress update to the voice intermediary.', inputSchema: { type: 'object', properties: { message_id: { type: 'string' }, text: { type: 'string' }, status: { type: 'string', enum: ['progress', 'completed', 'question', 'failed'] } }, required: ['message_id', 'text', 'status'], additionalProperties: false } },
] }));
mcp.setRequestHandler(CallToolRequestSchema, async request => {
  const { name, arguments: args } = request.params;
  if (!['acknowledge', 'reply'].includes(name) || typeof args?.message_id !== 'string' || !seen.has(args.message_id)) {
    return { isError: true, content: [{ type: 'text', text: 'Unknown voice message or tool.' }] };
  }
  if (name === 'reply' && (typeof args.text !== 'string' || args.text.length > 16000 || !['progress', 'completed', 'question', 'failed'].includes(args.status))) {
    return { isError: true, content: [{ type: 'text', text: 'Invalid reply text or status.' }] };
  }
  send({ type: `channel.${name}`, ...args });
  return { content: [{ type: 'text', text: 'Delivered to the local voice bridge.' }] };
});
await mcp.connect(new StdioServerTransport());
function connect() {
  socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` }, handshakeTimeout: 3000 });
  socket.on('open', () => {
    send({ type: 'channel.ready', pid: process.pid });
    for (const event of pendingEvents.splice(0)) send(event);
  });
  // Serialize notification writes to preserve order across simultaneous messages.
  let chain = Promise.resolve();
  socket.on('message', raw => {
    chain = chain.then(async () => {
      const event = JSON.parse(raw.toString());
      if (event.type !== 'channel.deliver' || typeof event.id !== 'string' || typeof event.content !== 'string') return;
      if (!seen.has(event.id)) {
        await mcp.notification({ method: 'notifications/claude/channel', params: { content: event.content, meta: { message_id: event.id, source_kind: 'voice_operator' } } });
        seen.add(event.id);
      }
      send({ type: 'channel.sent', id: event.id });
    }).catch(error => { console.error(error.message); send({ type: 'channel.error', message: error.message }); });
  });
  socket.on('error', error => console.error(`Voice bridge: ${error.message}`));
  socket.on('close', () => { if (!stopping) reconnectTimer = setTimeout(connect, 1000); });
}
function stop() { stopping = true; clearTimeout(reconnectTimer); socket?.terminate(); mcp.close().finally(() => process.exit(0)); }
process.stdin.on('end', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
connect();
