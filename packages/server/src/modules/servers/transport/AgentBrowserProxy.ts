import type { WebSocket } from 'ws';
import WsClient from 'ws';
import type { ServerConfig } from '../Server';
import { createBufferedMessageRelay, messageByteSize } from '../../../shared/utils/BufferedMessageRelay';

// The hub->agent WS connection (agentWs) takes a real network round-trip to
// establish. A client that sends a burst of messages right after its own WS
// opens (e.g. DevTools, which fires a large batch of CDP init commands
// immediately) would have that whole burst discarded if ws.on('message') is
// only registered inside agentWs.on('open') — same pattern already fixed in
// devtools.ts's handleDevtoolsRelay and browserHandler.ts's
// handleBrowserConnection. Buffer from the start and flush once agentWs is
// open. No coalescing: both the 'browser' (input events) and 'devtools' (CDP
// commands) modes share this one proxy, and CDP in particular requires
// strict order with nothing dropped, so treat every message the strict way.
const AGENT_PROXY_RELAY_MAX_BUFFERED = 1000;
const AGENT_PROXY_RELAY_MAX_BYTES = 5 * 1024 * 1024;

export function proxyBrowserToAgent(
  ws: WebSocket,
  server: ServerConfig,
  mode: 'browser' | 'devtools',
  extraParams?: string,
): void {
  if (!server.agentToken) {
    ws.send(JSON.stringify({ error: 'Agent token not configured' }));
    ws.close();
    return;
  }
  const base = `ws://${server.host}:${server.agentPort}`;
  const url = `${base}/ws?mode=${mode}${extraParams ? `&${extraParams}` : ''}`;
  const authHeader = `Bearer ${server.agentToken}`;

  const agentWs = new WsClient(url, { headers: { authorization: authHeader } });

  // Closes agentWs regardless of which state it's currently in. A plain
  // agentWs.close() is a no-op while the connection is still CONNECTING (the
  // 'ws' package only sends a close frame over an already-open socket), so
  // an overflow that happens before agentWs finishes connecting used to
  // leave it to open anyway right after — an orphaned hub->agent WS (and the
  // matching resources on the agent side) that nothing ever tears down.
  // terminate() forcibly ends a CONNECTING/any-state socket immediately.
  const closeAgentWs = (): void => {
    if (agentWs.readyState === WsClient.CONNECTING) {
      agentWs.terminate();
    } else if (agentWs.readyState === WsClient.OPEN) {
      agentWs.close();
    }
  };

  const messageRelay = createBufferedMessageRelay<Buffer | string>({
    maxBuffered: AGENT_PROXY_RELAY_MAX_BUFFERED,
    maxBytes: AGENT_PROXY_RELAY_MAX_BYTES,
    sizeOf: messageByteSize,
    onOverflow: () => {
      if (ws.readyState === ws.OPEN) ws.close(1011, 'relay buffer overflow');
      closeAgentWs();
    },
  });
  ws.on('message', (data: Buffer | string) => {
    messageRelay.push(data);
  });

  agentWs.on('open', () => {
    // The client may already be gone by the time this (network round-trip
    // away) connection finally completes — e.g. it disconnected, or this
    // overflow-triggered close raced ahead of open(). terminate() from
    // closeAgentWs() above only fires while still CONNECTING, so a
    // same-tick overflow that lands just as agentWs transitions to OPEN
    // needs this guard to still close it rather than proceed to relay a
    // (by now pointless, and via messageRelay.deliverTo, already-cleared)
    // buffer into a connection nobody is listening on the other end of.
    if (ws.readyState !== ws.OPEN) {
      agentWs.close();
      return;
    }
    messageRelay.deliverTo((data) => {
      if (agentWs.readyState === WsClient.OPEN) {
        agentWs.send(data.toString());
      }
    });
  });

  agentWs.on('message', (data: Buffer | string) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(data.toString());
    }
  });

  agentWs.on('close', () => {
    if (ws.readyState === ws.OPEN) ws.close();
  });

  agentWs.on('error', () => {
    messageRelay.clear();
    if (ws.readyState === ws.OPEN) ws.close();
  });

  ws.on('close', () => {
    messageRelay.clear();
    if (agentWs.readyState === WsClient.OPEN) agentWs.close();
  });
}
