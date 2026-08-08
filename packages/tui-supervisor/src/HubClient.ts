import WebSocket from 'ws';
import { mapKey } from './keymap';
import {
  SUPERVISOR_PROTOCOL_VERSION,
  type ActivityState,
  type AgentStatus,
  type ChildExitMessage,
  type HubToSupervisorMessage,
  type RegisterMessage,
  type SupervisorToHubMessage,
} from './protocol';

export interface HubClientOptions {
  /** Hub base URL (http/https — converted to ws/wss internally). */
  url: string;
  token: string;
  register: Omit<RegisterMessage, 'type' | 'protocolVersion' | 'reportsReady' | 'sessionToken'>;
  /** Writes raw bytes into the child PTY. Exceptions are caught and reported via ack. */
  write: (data: string) => void;
  /**
   * Child boot readiness gate. inject_prompt waits on it before pasting, so a
   * prompt sent right after worker startup is not written into a TUI that has
   * not finished booting (which silently loses it). send_keys/interrupt are
   * deliberately NOT gated — they target an already-running child.
   */
  readiness?: { waitUntilReady(): Promise<void>; isReady(): boolean };
  heartbeatMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Delay between injected prompt text and the submitting `\r` (2nd inject onward). */
  submitDelayMs?: number;
  /** Delay before `\r` for the FIRST inject_prompt after spawn (boot-time injection). */
  firstSubmitDelayMs?: number;
}

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

/**
 * Submit delay for the first inject_prompt after spawn. A freshly booted claude
 * TUI swallows an Enter arriving ~150ms after the paste (observed in E2E: the
 * paste sat in the composer unsubmitted). The legacy tmux path waited 2s before
 * Enter and had a 100% success record — mirror that timing.
 */
const FIRST_SUBMIT_DELAY_MS = 2_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    // unref: never keep the supervisor process alive just for a pending submit.
    setTimeout(resolve, ms).unref();
  });
}

/**
 * Maintains the supervisor's WebSocket connection to the hub: register handshake,
 * heartbeat, activity/child_exit reporting, and hub->supervisor command handling
 * (inject_prompt / send_keys / interrupt).
 *
 * Design rule: this client must NEVER break the PTY pass-through. Every callback
 * catches its own exceptions; connection loss degrades to silent reconnect with
 * exponential backoff, dropping activity/heartbeat while disconnected (only the
 * latest child_exit is buffered and re-sent, since it is the one message the hub
 * must not miss).
 */
export class HubClient {
  private readonly options: Required<
    Pick<HubClientOptions, 'heartbeatMs' | 'backoffBaseMs' | 'backoffMaxMs' | 'submitDelayMs' | 'firstSubmitDelayMs'>
  > &
    HubClientOptions;
  private ws: WebSocket | undefined;
  private registered = false;
  private reconnectAttempts = 0;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private pendingChildExit: ChildExitMessage | null = null;
  private firstInjectSeen = false;
  private closed = false;
  /**
   * Issue #28 Phase C (design v3 §8): once the hub returns a `sessionToken`
   * (ack for a register that consumed `options.register.bootstrapToken`),
   * every later register on this process — reconnects after a network blip
   * — must use it instead: `bootstrapToken` is one-shot and would be
   * rejected the second time. Cleared never; the token is valid for this
   * launch's whole process lifetime.
   */
  private sessionToken: string | undefined;

  constructor(options: HubClientOptions) {
    this.options = {
      heartbeatMs: 10_000,
      backoffBaseMs: 1_000,
      backoffMaxMs: 30_000,
      submitDelayMs: 150,
      firstSubmitDelayMs: FIRST_SUBMIT_DELAY_MS,
      ...options,
    };
  }

  connect(): void {
    if (this.closed) return;
    try {
      const wsUrl = this.options.url.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws/supervisor';
      const ws = new WebSocket(wsUrl, {
        headers: { Authorization: `Bearer ${this.options.token}` },
      });
      this.ws = ws;

      ws.on('open', () => {
        const { bootstrapToken, ...registerRest } = this.options.register;
        this.safeSend({
          type: 'register',
          protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
          ...registerRest,
          // Once a sessionToken has been issued (a prior register on THIS
          // process consumed the one-shot bootstrapToken), every later
          // register — including this reconnect — must use it instead; the
          // bootstrapToken would be rejected as already-consumed.
          ...(this.sessionToken !== undefined ? { sessionToken: this.sessionToken } : { bootstrapToken }),
          // This build always reports a 'ready' frame once the child TUI boots — fixed here
          // rather than threaded through `options.register` (every current HubClient does this,
          // there's no variant that doesn't).
          reportsReady: true,
        });
      });

      ws.on('message', (raw) => {
        try {
          this.handleMessage(raw.toString());
        } catch {
          // Malformed/unexpected messages must never break the pass-through.
        }
      });

      ws.on('error', () => {
        // Swallow — 'close' follows and drives the reconnect.
      });

      ws.on('close', () => {
        this.onDisconnected();
      });
    } catch {
      this.scheduleReconnect();
    }
  }

  sendActivity(state: ActivityState, bytesInWindow: number, status?: AgentStatus): void {
    // Dropped while disconnected by design: stale activity is worthless.
    if (!this.registered) return;
    this.safeSend({ type: 'activity', state, bytesInWindow, ts: Date.now(), status });
  }

  /**
   * Reports that the child TUI's ReadinessGate has latched. Like sendActivity,
   * dropped while unregistered — a "ready" reported before the hub knows about
   * this supervisor would arrive to nothing. The registered handler re-sends
   * this on reconnect when the gate is already latched.
   */
  sendReady(): void {
    if (!this.registered) return;
    this.safeSend({ type: 'ready', ts: Date.now() });
  }

  sendChildExit(exitCode: number | null, signal: number | null): void {
    const msg: ChildExitMessage = { type: 'child_exit', exitCode, signal, ts: Date.now() };
    if (this.registered && this.ws?.readyState === WebSocket.OPEN) {
      this.safeSend(msg);
    } else {
      // Buffer exactly one child_exit for re-send after reconnect.
      this.pendingChildExit = msg;
    }
  }

  close(): void {
    this.closed = true;
    this.clearTimers();
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
  }

  private handleMessage(raw: string): void {
    const msg = JSON.parse(raw) as HubToSupervisorMessage;
    switch (msg.type) {
      case 'registered':
        this.registered = true;
        this.reconnectAttempts = 0;
        if (msg.sessionToken !== undefined) {
          this.sessionToken = msg.sessionToken;
          // Issue #28 third-party review, Important finding: confirm receipt of the
          // freshly-minted session token right away, on this same connection, so the
          // hub can retire the one-shot bootstrapToken now rather than waiting for a
          // reconnect that (with this HubClient's own "keep using the live socket"
          // design) may never come. Additive — a hub predating this message type just
          // ignores it.
          this.safeSend({ type: 'register_ack', sessionToken: msg.sessionToken });
        }
        this.startHeartbeat();
        if (this.pendingChildExit) {
          this.safeSend(this.pendingChildExit);
          this.pendingChildExit = null;
        }
        // Re-announce an already-latched gate after (re)connecting, so a hub
        // restart or a supervisor reconnect never leaves it thinking the
        // child is still booting.
        if (this.options.readiness?.isReady()) {
          this.sendReady();
        }
        break;
      case 'inject_prompt':
        // "First" = the first inject_prompt this HubClient instance handles.
        // Supervisor and child lifecycles are 1:1 (one spawn per process), so
        // this is exactly the boot-time injection; from the 2nd inject onward
        // the child TUI is proven running (150ms Enter has a 100% record there).
        // Chosen over "gate was not yet ready" because the gate can latch ready
        // while the TUI's input handling is still settling.
        {
          const isFirstInject = !this.firstInjectSeen;
          this.firstInjectSeen = true;
          void this.runCommand(msg.id, async () => {
            // Wait for the child TUI to finish booting before pasting; resolves
            // after the gate's max wait even if never ready (inject anyway —
            // better than refusing).
            await this.options.readiness?.waitUntilReady();
            this.options.write(BRACKETED_PASTE_START + msg.text + BRACKETED_PASTE_END);
            if (msg.submit) {
              // The ack must reflect the WHOLE command including the submitting
              // `\r` — acking before it would let a failed Enter (child exited
              // during the delay) look like a success to the hub.
              await delay(isFirstInject ? this.options.firstSubmitDelayMs : this.options.submitDelayMs);
              this.options.write('\r');
            }
          });
        }
        break;
      case 'send_keys':
        void this.runCommand(msg.id, () => {
          this.options.write(msg.keys.map(mapKey).join(''));
        });
        break;
      case 'interrupt':
        void this.runCommand(msg.id, () => {
          this.options.write('\x03');
        });
        break;
      default:
        // Unknown message types are ignored (forward compatibility).
        break;
    }
  }

  private async runCommand(id: string, fn: () => void | Promise<void>): Promise<void> {
    try {
      await fn();
      this.safeSend({ type: 'ack', id, ok: true });
    } catch (err) {
      this.safeSend({ type: 'ack', id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  private safeSend(msg: SupervisorToHubMessage): void {
    try {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(msg));
      }
    } catch {
      // Send failures are non-fatal; the close handler drives recovery.
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.safeSend({ type: 'heartbeat', ts: Date.now() });
    }, this.options.heartbeatMs);
    this.heartbeatTimer.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private onDisconnected(): void {
    this.registered = false;
    this.stopHeartbeat();
    this.ws = undefined;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = Math.min(
      this.options.backoffBaseMs * 2 ** this.reconnectAttempts,
      this.options.backoffMaxMs,
    );
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
    this.reconnectTimer.unref();
  }

  private clearTimers(): void {
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }
}
