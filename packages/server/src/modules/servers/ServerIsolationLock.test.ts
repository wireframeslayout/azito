import { describe, it, expect } from 'vitest';
import { withServerLock, ServerSnapshotMismatchError } from './ServerIsolationLock';
import { KeyedMutex } from '../../shared/keyedMutex';
import type { ServerConfig } from './Server';

const base = { name: 's', type: 'local', host: null, agentPort: null, agentToken: null, sshHost: null, muxRuntime: 'system', defaultMux: 'tmux', isolationIntent: false } as ServerConfig;

function lockWith(current: ServerConfig) {
  return { serverIsolationMutex: new KeyedMutex(), serverRepo: { findByName: () => current } };
}

describe('withServerLock snapshot check', () => {
  it('passes when nothing security-relevant changed', async () => {
    await expect(withServerLock(lockWith({ ...base }), base, true, async (s) => s.name)).resolves.toBe('s');
  });

  it('rejects a change of only defaultMux (the driver switched under the caller)', async () => {
    await expect(withServerLock(lockWith({ ...base, defaultMux: 'misao' }), base, true, async () => 'ran')).rejects.toBeInstanceOf(ServerSnapshotMismatchError);
  });

  it('rejects a change of only muxRuntime', async () => {
    await expect(withServerLock(lockWith({ ...base, muxRuntime: 'managed' }), base, true, async () => 'ran')).rejects.toBeInstanceOf(ServerSnapshotMismatchError);
  });
});
