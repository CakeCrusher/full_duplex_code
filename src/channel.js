#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
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
  capabilities: { experimental: { 'claude/channel': {} } },
  instructions: 'Messages on this channel are transcribed requests from the user. Handle them in this conversation at your normal processing opportunities and respond normally in the terminal. If a transcription is ambiguous, ask for clarification.',
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
