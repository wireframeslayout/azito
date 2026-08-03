import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import { proxyBrowserToAgent } from '../AgentBrowserProxy';
import type { ServerConfig } from '../../Server';

// Minimal fake satisfying the subset of the 'ws' WebSocket API this handler
// uses for the *client* connection: on('message'|'close'), send(), close(),
// readyState/OPEN. Mirrors devtools.test.ts's FakeClientWebSocket.
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
// by proxyBrowserToAgent for the hub->agent connection. Starts CONNECTING
// (readyState 0); tests drive it to OPEN explicitly via open(), the way a
// real connection completes asynchronously (network round-trip) after the
// handler has already started receiving client messages.
class FakeAgentWs extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static instances: FakeAgentWs[] = [];

  readyState = 0;
  sent: string[] = [];
  url: string;
  opts: unknown;
  closeCalled = false;
  terminateCalled = false;

  constructor(url: string, opts?: unknown) {
    super();
    this.url = url;
    this.opts = opts;
    FakeAgentWs.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  // Mirrors the real 'ws' package: close() only actually does anything (and
  // emits 'close') for an already-OPEN socket — it's a no-op while still
  // CONNECTING, which is exactly the gap terminate() exists to cover.
  close(): void {
    this.closeCalled = true;
    if (this.readyState !== FakeAgentWs.OPEN) return;
    this.readyState = 3;
    this.emit('close');
  }

  terminate(): void {
    this.terminateCalled = true;
    this.readyState = 3;
    this.emit('close');
  }

  /** Test helper: completes the upstream connection. */
  open(): void {
    this.readyState = FakeAgentWs.OPEN;
    this.emit('open');
  }
}

// vi.mock factories are hoisted above the rest of the file (including class
// declarations below), so the factory itself must not reference FakeAgentWs
// eagerly — only from inside a nested function, deferred until the mock is
// actually used. Mirrors the same indirection in devtools.test.ts /
// AgentEventStream.test.ts for the same 'ws' default-export mock.
vi.mock('ws', () => ({
  default: class {
    constructor(url: string, opts?: unknown) {
      return new FakeAgentWs(url, opts) as unknown as never;
    }
    static get CONNECTING() { return FakeAgentWs.CONNECTING; }
    static get OPEN() { return FakeAgentWs.OPEN; }
  },
}));

const server: ServerConfig = {
  name: 'agent-server',
  type: 'agent',
  host: '100.64.0.1',
  agentPort: 4100,
  agentToken: 'test-token',
  agentVersion: '1.0.0',
  sshHost: null,
  sshHostFingerprint: null,
  muxRuntime: 'system',
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('proxyBrowserToAgent — buffering before the hub->agent WS connection is ready', () => {
  // Regression: the hub->agent WS connection (agentWs) takes a real network
  // round-trip to establish. The old code only registered ws.on('message')
  // inside agentWs.on('open'), so a client burst sent right after its own WS
  // opened — e.g. DevTools' large batch of CDP init commands — arrived with
  // no listener attached and was silently dropped. Over the agent transport
  // this made the DevTools panel come up empty (same pattern already fixed
  // for the local devtools.ts / browserHandler.ts relays).
  it('delivers messages sent before agentWs opens, in order, once it does', () => {
    FakeAgentWs.instances = [];
    const ws = new FakeClientWebSocket();

    proxyBrowserToAgent(ws as unknown as WebSocket, server, 'devtools', 'target=ABCDEF');

    const agentWs = FakeAgentWs.instances[0];
    expect(agentWs).toBeDefined();

    // Sent while the upstream connection is still CONNECTING — must not be lost.
    ws.emit('message', Buffer.from(JSON.stringify({ id: 1, method: 'Target.setAutoAttach' })));
    ws.emit('message', Buffer.from(JSON.stringify({ id: 2, method: 'Runtime.enable' })));
    expect(agentWs.sent).toHaveLength(0);

    agentWs.open();

    expect(agentWs.sent).toEqual([
      JSON.stringify({ id: 1, method: 'Target.setAutoAttach' }),
      JSON.stringify({ id: 2, method: 'Runtime.enable' }),
    ]);

    // Messages arriving after agentWs is open go straight through too, after
    // the buffered ones, preserving overall arrival order.
    ws.emit('message', Buffer.from(JSON.stringify({ id: 3, method: 'Page.enable' })));
    expect(agentWs.sent).toEqual([
      JSON.stringify({ id: 1, method: 'Target.setAutoAttach' }),
      JSON.stringify({ id: 2, method: 'Runtime.enable' }),
      JSON.stringify({ id: 3, method: 'Page.enable' }),
    ]);
  });

  it('closes the client connection with code 1011 if the pre-open buffer overflows', () => {
    FakeAgentWs.instances = [];
    const ws = new FakeClientWebSocket();

    proxyBrowserToAgent(ws as unknown as WebSocket, server, 'devtools', 'target=ABCDEF');
    const agentWs = FakeAgentWs.instances[0];

    // AGENT_PROXY_RELAY_MAX_BUFFERED is 1000 — push past it while agentWs is
    // still connecting (never call agentWs.open()).
    for (let i = 0; i < 1001; i++) {
      ws.emit('message', Buffer.from(JSON.stringify({ id: i, method: 'Runtime.enable' })));
    }

    expect(ws.readyState).toBe(3);
    expect(ws.lastClose).toEqual({ code: 1011, reason: 'relay buffer overflow' });

    // Upstream never got a chance to send anything — the whole buffer was
    // torn down on overflow, not partially flushed.
    agentWs.open();
    expect(agentWs.sent).toHaveLength(0);
  });

  // Regression: onOverflow used to only close agentWs when it was already
  // OPEN. A plain close() is a no-op on the real 'ws' package while the
  // socket is still CONNECTING, so an overflow that happens before agentWs
  // finishes connecting left it free to open anyway right after — an
  // orphaned hub->agent WS (and the agent-side resources behind it) that
  // nothing would ever tear down.
  it('terminates agentWs immediately on overflow while it is still CONNECTING, and closes it too if it opens anyway afterward', () => {
    FakeAgentWs.instances = [];
    const ws = new FakeClientWebSocket();

    proxyBrowserToAgent(ws as unknown as WebSocket, server, 'devtools', 'target=ABCDEF');
    const agentWs = FakeAgentWs.instances[0];
    expect(agentWs.readyState).toBe(FakeAgentWs.CONNECTING);

    for (let i = 0; i < 1001; i++) {
      ws.emit('message', Buffer.from(JSON.stringify({ id: i, method: 'Runtime.enable' })));
    }

    // While still CONNECTING, a plain close() wouldn't do anything on the
    // real socket — terminate() must have been used instead.
    expect(agentWs.terminateCalled).toBe(true);

    // If the (network round-trip away) connection still completes after the
    // overflow — a real-world race the CONNECTING-only terminate() can't
    // preempt — the client-closed guard at the top of agentWs.on('open')
    // must close it too, rather than relay a stale/cleared buffer into a
    // connection nobody is listening on the other end of.
    agentWs.open();
    expect(agentWs.closeCalled).toBe(true);
    expect(agentWs.sent).toHaveLength(0);
  });

  it('clears the buffer instead of delivering it once the client disconnects before agentWs opens', () => {
    FakeAgentWs.instances = [];
    const ws = new FakeClientWebSocket();

    proxyBrowserToAgent(ws as unknown as WebSocket, server, 'browser', 'page=t1&group=default');
    const agentWs = FakeAgentWs.instances[0];

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'resize', width: 800, height: 600 })));
    ws.close();
    agentWs.open();

    expect(agentWs.sent).toHaveLength(0);
  });
});
