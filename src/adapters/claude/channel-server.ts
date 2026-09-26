#!/usr/bin/env node
// The voice channel: an MCP server Claude runs as a child process. It connects
// back to the bridge at /channel and writes each voice request to Claude as a
// channel notification.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import WebSocket from 'ws';
import { channelNotification } from './channel-message.ts';

// Stdout belongs exclusively to MCP JSON-RPC.
const url = process.env.FD_BRIDGE_URL;
const token = process.env.FD_BRIDGE_TOKEN;
if (!url || !token || !/^ws:\/\/127\.0\.0\.1:\d+\/channel$/.test(url)) {
  console.error('Voice channel requires its local harness connection. Start with npm start.');
  process.exit(1);
}
let socket: WebSocket | undefined;
let stopping = false;
let reconnectTimer: NodeJS.Timeout | undefined;
const seen = new Set<string>();
const pendingEvents: Record<string, unknown>[] = [];
function send(event: Record<string, unknown>) {
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
  const ws = socket = new WebSocket(url!, { headers: { Authorization: `Bearer ${token}` }, handshakeTimeout: 3000 });
  ws.on('open', () => {
    send({ type: 'channel.ready', pid: process.pid });
    for (const event of pendingEvents.splice(0)) send(event);
  });
  // Serialize notification writes to preserve order across simultaneous messages.
  let chain = Promise.resolve();
  ws.on('message', raw => {
    chain = chain.then(async () => {
      const event = JSON.parse(raw.toString());
      if (event.type !== 'channel.deliver' || typeof event.id !== 'string' || typeof event.content !== 'string') return;
      if (!seen.has(event.id)) {
        const { jsonrpc, ...notification } = channelNotification(event);
        await mcp.notification(notification);
        seen.add(event.id);
      }
      send({ type: 'channel.sent', id: event.id });
    }).catch(error => { console.error(error.message); send({ type: 'channel.error', message: error.message }); });
  });
  ws.on('error', error => console.error(`Voice bridge: ${error.message}`));
  ws.on('close', () => { if (!stopping) reconnectTimer = setTimeout(connect, 1000); });
}
function stop() { stopping = true; clearTimeout(reconnectTimer); socket?.terminate(); mcp.close().finally(() => process.exit(0)); }
process.stdin.on('end', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
connect();
