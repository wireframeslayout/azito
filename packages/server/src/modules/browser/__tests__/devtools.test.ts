import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import { handleDevtoolsRelay } from '../devtools';

// Minimal fake satisfying the subset of the 'ws' WebSocket API this handler
// uses for the *client* connection: on('message'|'close'), send(), close(),
// readyState/OPEN. Mirrors browserHandler.test.ts's FakeWebSocket.
class FakeClientWebSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  lastClose: { code?: number; reason?: string } | null = null;
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.lastClose = { code, reason };
    this.readyState = 3;
    this.emit('close');
  }
}

// Fake upstream ws.WebSocket ('ws' package's default export), used internally
// by handleDevtoolsRelay to connect to Chromium's CDP endpoint. Starts
// CONNECTING (readyState 0); tests drive it to OPEN explicitly via open(), the
// way a real upstream connection completes asynchronously after the handler
// has already started receiving client messages.
class FakeUpstreamWs extends EventEmitter {
  static OPEN = 1;
  static instances: FakeUpstreamWs[] = [];

  readyState = 0;
  sent: string[] = [];
  url: string;

  constructor(url: string) {
    super();
    this.url = url;
    FakeUpstreamWs.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit('close');
  }

  /** Test helper: completes the upstream connection. */
  open(): void {
    this.readyState = FakeUpstreamWs.OPEN;
    this.emit('open');
  }
}

// vi.mock factories are hoisted above the rest of the file (including class
// declarations below), so the factory itself must not reference
// FakeUpstreamWs eagerly — only from inside a nested function, deferred until
// the mock is actually used (well after the whole file has finished
// evaluating). Mirrors the indirection AgentEventStream.test.ts uses for the
// same 'ws' default-export mock.
vi.mock('ws', () => ({
  default: class {
    constructor(url: string) {
      return new FakeUpstreamWs(url) as unknown as never;
    }
    static get OPEN() { return FakeUpstreamWs.OPEN; }
  },
}));

const VALID_TARGET = 'A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6';

describe('handleDevtoolsRelay — buffering before the upstream CDP connection is ready', () => {
  // Regression: the DevTools frontend fires a large burst of CDP commands
  // immediately on WS open — well before the upstream connection to Chromium
  // finishes connecting. The old code only registered ws.on('message') inside
  // cdpWs.on('open'), so that entire early burst arrived with no listener
  // attached and was silently dropped, leaving DevTools stuck showing
  // "disconnected" (no responses ever came back for its init commands).
  it('delivers CDP messages sent before upstream opens, in order, once it does', async () => {
    FakeUpstreamWs.instances = [];
    const ws = new FakeClientWebSocket();

    handleDevtoolsRelay(ws as unknown as WebSocket, VALID_TARGET);

    const cdpWs = FakeUpstreamWs.instances[0];
    expect(cdpWs).toBeDefined();

    // Sent while the upstream connection is still CONNECTING — must not be lost.
    ws.emit('message', Buffer.from(JSON.stringify({ id: 1, method: 'Target.setAutoAttach' })));
    ws.emit('message', Buffer.from(JSON.stringify({ id: 2, method: 'Runtime.enable' })));
    expect(cdpWs.sent).toHaveLength(0);

    cdpWs.open();

    expect(cdpWs.sent).toEqual([
      JSON.stringify({ id: 1, method: 'Target.setAutoAttach' }),
      JSON.stringify({ id: 2, method: 'Runtime.enable' }),
    ]);

    // Messages arriving after upstream is open go straight through too, after
    // the buffered ones, preserving overall arrival order.
    ws.emit('message', Buffer.from(JSON.stringify({ id: 3, method: 'Page.enable' })));
    expect(cdpWs.sent).toEqual([
      JSON.stringify({ id: 1, method: 'Target.setAutoAttach' }),
      JSON.stringify({ id: 2, method: 'Runtime.enable' }),
      JSON.stringify({ id: 3, method: 'Page.enable' }),
    ]);
  });

  // Regression/design intent: unlike the browser input-event relay
  // (drop-oldest — losing an old mouse event is harmless), losing a single
  // buffered CDP command is unrecoverable: DevTools would be left waiting
  // forever on a response to a request it thinks it sent but which never
  // reached Chromium. So instead of silently evicting, an overflow here must
  // tear the connection down loudly.
  it('closes the client connection with code 1011 if the pre-open buffer overflows', () => {
    FakeUpstreamWs.instances = [];
    const ws = new FakeClientWebSocket();

    handleDevtoolsRelay(ws as unknown as WebSocket, VALID_TARGET);
    const cdpWs = FakeUpstreamWs.instances[0];

    // DEVTOOLS_RELAY_MAX_BUFFERED is 1000 — push past it while upstream is
    // still connecting (never call cdpWs.open()).
    for (let i = 0; i < 1001; i++) {
      ws.emit('message', Buffer.from(JSON.stringify({ id: i, method: 'Runtime.enable' })));
    }

    expect(ws.readyState).toBe(3);
    expect(ws.lastClose).toEqual({ code: 1011, reason: 'relay buffer overflow' });

    // Upstream never got a chance to send anything — the whole buffer was
    // torn down on overflow, not partially flushed.
    cdpWs.open();
    expect(cdpWs.sent).toHaveLength(0);
  });

  it('clears the buffer instead of delivering it once the client disconnects before upstream opens', () => {
    FakeUpstreamWs.instances = [];
    const ws = new FakeClientWebSocket();

    handleDevtoolsRelay(ws as unknown as WebSocket, VALID_TARGET);
    const cdpWs = FakeUpstreamWs.instances[0];

    ws.emit('message', Buffer.from(JSON.stringify({ id: 1, method: 'Runtime.enable' })));
    ws.close();
    cdpWs.open();

    expect(cdpWs.sent).toHaveLength(0);
  });
});
