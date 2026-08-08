import { describe, it, expect, vi, afterEach } from 'vitest';
import { TmuxClient } from './TmuxClient';
import type { ServerConfig } from '../servers/Server';
import type { TransportFactory } from '../servers/transport/TransportFactory';

const srv: ServerConfig = { name: 'local', type: 'local' } as ServerConfig;
const PUBLIC_URL = 'http://100.64.1.42:3001';
const LOCAL_URL = 'http://127.0.0.1:3001';

function makeClient(
  execTmux: (args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>,
): TmuxClient {
  const factory = {
    getTransport: () => ({ execTmux: vi.fn(execTmux) }),
  } as unknown as TransportFactory;
  return new TmuxClient(factory, PUBLIC_URL, '', LOCAL_URL);
}

// Issue #28 Phase A last-round fix: setWindowStatusFormat() (the tmux
// status-bar label set right after `new-window`/`new-session`) is decorative
// only. WindowRotation.createRotatedWindow() treats ANY rejection out of its
// `create` callback as "the window was never actually created" and revokes
// the just-issued task-token generation on that basis — so if this
// post-creation decoration step were allowed to throw, a window that DID get
// created (the primary `new-window`/`new-session` command already
// succeeded) would be misreported as never having existed, leaving a live,
// untracked pane holding a revoked token.
describe('TmuxClient setWindowStatusFormat (post-creation decoration is best-effort)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('createWindow resolves even when the window-status-format command fails', async () => {
    const client = makeClient(async (args) => {
      if (args[0] === 'set-window-option') {
        throw new Error('tmux: window-status-format failed');
      }
      return { stdout: '', stderr: '', code: 0 };
    });

    const result = await client.createWindow(srv, 'test-session', 'win');

    expect(result.result.code).toBe(0);
    expect(result.windowName).toMatch(/^win--[a-z0-9]{4}$/);
  });

  it('createSession resolves even when the window-status-format command fails', async () => {
    const client = makeClient(async (args) => {
      if (args[0] === 'set-window-option') {
        throw new Error('tmux: window-status-format failed');
      }
      return { stdout: '', stderr: '', code: 0 };
    });

    const result = await client.createSession(srv, 'test-session', { windowName: 'win' });

    expect(result.result.code).toBe(0);
    expect(result.windowName).toMatch(/^win--[a-z0-9]{4}$/);
  });

  it('logs a warning (rather than swallowing silently) when window-status-format fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = makeClient(async (args) => {
      if (args[0] === 'set-window-option') {
        throw new Error('tmux: window-status-format failed');
      }
      return { stdout: '', stderr: '', code: 0 };
    });

    await client.createWindow(srv, 'test-session', 'win');

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('window-status-format failed'));
  });

  it('does not attempt window-status-format at all when the window name carries no id suffix (exactName)', async () => {
    const calls: string[][] = [];
    const client = makeClient(async (args) => {
      calls.push(args);
      return { stdout: '', stderr: '', code: 0 };
    });

    await client.createWindow(srv, 'test-session', 'task-1', { exactName: true });

    expect(calls.some((c) => c[0] === 'set-window-option')).toBe(false);
  });
});
