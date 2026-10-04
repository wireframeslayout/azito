import { describe, expect, it, vi } from 'vitest';
import type { MuxRef } from '@azito/shared';
import type { ServerConfig } from '../servers/Server';
import type { IMuxClient } from './IMuxClient';
import { MuxOperationUnsupportedError } from './MuxCapabilityError';
import { TmuxClient } from './TmuxClient';
import { labelAddedWindowOrRemove, labelRegisteredWindow } from './labelRegisteredWindow';
import { MuxDriverRegistry } from './MuxDriverRegistry';

const server = { name: 'local', type: 'local' } as ServerConfig;
const ref: MuxRef = { kind: 'misao', workspace: 'proj', window: 'w_0000000000000000000000000Z' };

describe('labelRegisteredWindow', () => {
  it('labels through a driver that keeps pane labels', async () => {
    const labelWindowPanes = vi.fn(async () => {});
    await labelRegisteredWindow({ supportsPaneLabels: true, labelWindowPanes } as unknown as IMuxClient, server, ref, { windowId: 806, taskId: 448 });
    expect(labelWindowPanes).toHaveBeenCalledWith(server, ref, { windowId: 806, taskId: 448 });
  });

  it('does nothing for a driver without pane labels', async () => {
    const labelWindowPanes = vi.fn(async () => {});
    await labelRegisteredWindow({ supportsPaneLabels: false, labelWindowPanes } as unknown as IMuxClient, server, ref, { windowId: 806 });
    expect(labelWindowPanes).not.toHaveBeenCalled();
  });

  it('propagates a labelling failure', async () => {
    const labelWindowPanes = vi.fn(async () => { throw new Error('rpc down'); });
    await expect(labelRegisteredWindow({ supportsPaneLabels: true, labelWindowPanes } as unknown as IMuxClient, server, ref, { windowId: 1 })).rejects.toThrow('rpc down');
  });

  it('is a no-op for the tmux driver, whose labelWindowPanes is explicitly unsupported', async () => {
    const tmux = new TmuxClient({ getTransport: () => { throw new Error('tmux must not be touched'); } } as never, '', '', '', '');
    expect(tmux.supportsPaneLabels).toBe(false);
    await expect(labelRegisteredWindow(tmux, server, { kind: 'tmux', workspace: 's', window: 'w' }, { windowId: 1 })).resolves.toBeUndefined();
    await expect(tmux.labelWindowPanes(server, ref, { windowId: 1 })).rejects.toBeInstanceOf(MuxOperationUnsupportedError);
  });
});

describe('labelAddedWindowOrRemove', () => {
  it('keeps the row when labelling succeeds', async () => {
    const remove = vi.fn();
    const labelWindowPanes = vi.fn(async () => {});
    await labelAddedWindowOrRemove({ supportsPaneLabels: true, labelWindowPanes } as unknown as IMuxClient, server, ref, { windowId: 806 }, { remove });
    expect(labelWindowPanes).toHaveBeenCalledWith(server, ref, { windowId: 806 });
    expect(remove).not.toHaveBeenCalled();
  });

  it('removes the added row and rethrows when labelling fails', async () => {
    const remove = vi.fn();
    const labelWindowPanes = vi.fn(async () => { throw new Error('rpc down'); });
    await expect(labelAddedWindowOrRemove({ supportsPaneLabels: true, labelWindowPanes } as unknown as IMuxClient, server, ref, { windowId: 806 }, { remove })).rejects.toThrow('rpc down');
    expect(remove).toHaveBeenCalledWith(806);
  });

  it('does not touch the row for a driver without pane labels', async () => {
    const remove = vi.fn();
    await labelAddedWindowOrRemove({ supportsPaneLabels: false, labelWindowPanes: vi.fn() } as unknown as IMuxClient, server, ref, { windowId: 806 }, { remove });
    expect(remove).not.toHaveBeenCalled();
  });
});

// The helper respawn / task execution / restore use to stamp a (re)created window: decided by the window's own mux.
describe('labelRegisteredWindow through the routing driver (#311)', () => {
  const misaoRef2: MuxRef = { kind: 'misao', workspace: 'ws', window: 'w_01M3XFD8H97JCPKS5Y5BH3JZQH' };
  const tmuxRef: MuxRef = { kind: 'tmux', workspace: 'ws', window: 'editor' };

  for (const defaultMux of ['tmux', 'misao'] as const) {
    it(`labels a misao window and leaves a tmux window unlabelled on a ${defaultMux}-default server`, async () => {
      const tmuxLabel = vi.fn(async () => { throw new Error('tmux keeps no pane labels'); });
      const misaoLabel = vi.fn(async () => {});
      const registry = new MuxDriverRegistry();
      registry.register('tmux', { kind: 'tmux', supportsPaneLabels: false, labelWindowPanes: tmuxLabel } as unknown as IMuxClient);
      registry.register('misao', { kind: 'misao', supportsPaneLabels: true, labelWindowPanes: misaoLabel } as unknown as IMuxClient);
      const server = { name: 'local', type: 'local', defaultMux } as ServerConfig;
      const driver = registry.resolve(server);

      await labelRegisteredWindow(driver, server, misaoRef2, { windowId: 1, taskId: 2 });
      await expect(labelRegisteredWindow(driver, server, tmuxRef, { windowId: 3 })).resolves.toBeUndefined();

      expect(misaoLabel).toHaveBeenCalledWith(server, misaoRef2, { windowId: 1, taskId: 2 });
      expect(tmuxLabel).not.toHaveBeenCalled();
    });
  }
});
