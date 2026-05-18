#!/usr/bin/env node
// Raw sniffer for the ESP32 pushup WebSocket. Run with: node esp32/sniff.mjs
// Requires Node 22+ (global WebSocket) or Node with --experimental-websocket.

const URL = "ws://10.10.11.209/ws";

const ws = new WebSocket(URL);

ws.addEventListener("open", () => {
  console.log(`[open] connected to ${URL}`);
});

ws.addEventListener("message", (event) => {
  console.log(event.data);
});

ws.addEventListener("close", (event) => {
  console.log(`[close] code=${event.code} reason=${event.reason || "(none)"}`);
  process.exit(0);
});

ws.addEventListener("error", (event) => {
  console.error(`[error]`, event.message || event);
});

process.on("SIGINT", () => {
  ws.close();
});
