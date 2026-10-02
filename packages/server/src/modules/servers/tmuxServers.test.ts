import { describe, it, expect } from 'vitest';
import { partitionByTmuxRuntime } from './tmuxServers';

describe('partitionByTmuxRuntime', () => {
  it('keeps system and managed servers and skips misao servers, preserving order', () => {
    const servers = [
      { name: 'a', muxRuntime: 'system' as const },
      { name: 'b', muxRuntime: 'misao' as const },
      { name: 'c', muxRuntime: 'managed' as const },
      { name: 'd', muxRuntime: 'misao' as const },
    ];
    const { tmux, skipped } = partitionByTmuxRuntime(servers);
    expect(tmux.map((s) => s.name)).toEqual(['a', 'c']);
    expect(skipped.map((s) => s.name)).toEqual(['b', 'd']);
  });

  it('returns empty groups for no servers', () => {
    expect(partitionByTmuxRuntime([])).toEqual({ tmux: [], skipped: [] });
  });
});
