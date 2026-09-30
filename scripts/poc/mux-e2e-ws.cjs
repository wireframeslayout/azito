#!/usr/bin/env node
// WebSocket connectivity test for mux-e2e.sh.
// Usage: node mux-e2e-ws.cjs <ws_url> <token>
// Prints "connected" on success, exits 0. Exits 1 on failure.
'use strict';

const WebSocket = require('ws');

const url = process.argv[2];
const token = process.argv[3];
if (!url || !token) {
  console.error('Usage: node mux-e2e-ws.cjs <ws_url> <token>');
  process.exit(1);
}

const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
const timeout = setTimeout(() => {
  console.error('timeout');
  ws.terminate();
  process.exit(1);
}, 5000);

ws.on('open', () => {
  console.log('connected');
  clearTimeout(timeout);
  setTimeout(() => {
    ws.close();
    process.exit(0);
  }, 500);
});

ws.on('error', (err) => {
  console.error('ws_error:', err.message);
  clearTimeout(timeout);
  process.exit(1);
});

ws.on('close', (code) => {
  if (code === 4404) {
    console.error('window_not_found');
  }
  clearTimeout(timeout);
});
