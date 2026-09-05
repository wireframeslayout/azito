import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PaneHandleResolver } from './PaneHandleResolver';
import { asPaneHandle } from '@azito/shared';
import type { MuxRef, PaneOrdinal } from '@azito/shared';

function makeRef(workspace = 'sess', window = 'win'): MuxRef {
  return { kind: 'tmux', workspace, window };
}

function makeMuxDriverRegistry(refResult: { ref: MuxRef; ordinal: PaneOrdinal } | null = null) {
  const driver = {
    refFromPaneHandle: vi.fn().mockResolvedValue(refResult),
  };
  return {
    resolve: () => driver,
    _driver: driver,
  } as any;
}

function makeWindowRepo(win: { id: number; tmuxTarget: string } | undefined = undefined) {
  return {
    findByServerAndRef: vi.fn().mockReturnValue(win),
  } as any;
}

function makeServerRepo(exists = true) {
  return {
    findByName: vi.fn().mockReturnValue(exists ? { name: 'local', type: 'local', muxRuntime: 'system' } : undefined),
  } as any;
}

describe('PaneHandleResolver', () => {
  const handle = asPaneHandle('%42');
  const ref = makeRef();
  const win = { id: 10, tmuxTarget: 'sess:win', serverName: 'local' };

  it('resolves a pane handle to a window', async () => {
    const resolver = new PaneHandleResolver(
      makeMuxDriverRegistry({ ref, ordinal: 0 }),
      makeWindowRepo(win),
      makeServerRepo(),
    );
    const result = await resolver.resolveWindowByPaneHandle('local', handle);
    expect(result).toEqual({ windowId: 10, ref, ordinal: 0, tmuxTarget: 'sess:win' });
  });

  it('returns null for unknown server', async () => {
    const resolver = new PaneHandleResolver(
      makeMuxDriverRegistry(),
      makeWindowRepo(),
      makeServerRepo(false),
    );
    const result = await resolver.resolveWindowByPaneHandle('unknown', handle);
    expect(result).toBeNull();
  });

  it('returns null when refFromPaneHandle returns null', async () => {
    const resolver = new PaneHandleResolver(
      makeMuxDriverRegistry(null),
      makeWindowRepo(),
      makeServerRepo(),
    );
    const result = await resolver.resolveWindowByPaneHandle('local', handle);
    expect(result).toBeNull();
  });

  it('returns null when window not found by ref', async () => {
    const resolver = new PaneHandleResolver(
      makeMuxDriverRegistry({ ref, ordinal: 0 }),
      makeWindowRepo(undefined),
      makeServerRepo(),
    );
    const result = await resolver.resolveWindowByPaneHandle('local', handle);
    expect(result).toBeNull();
  });

  it('caches positive results for 30s', async () => {
    const muxRegistry = makeMuxDriverRegistry({ ref, ordinal: 0 });
    const driver = muxRegistry._driver;
    const resolver = new PaneHandleResolver(muxRegistry, makeWindowRepo(win), makeServerRepo());

    await resolver.resolveWindowByPaneHandle('local', handle);
    expect(driver.refFromPaneHandle).toHaveBeenCalledTimes(1);

    await resolver.resolveWindowByPaneHandle('local', handle);
    expect(driver.refFromPaneHandle).toHaveBeenCalledTimes(1);
  });

  it('caches negative results for 5s', async () => {
    const muxRegistry = makeMuxDriverRegistry(null);
    const driver = muxRegistry.resolve();
    const resolver = new PaneHandleResolver(muxRegistry, makeWindowRepo(), makeServerRepo());

    await resolver.resolveWindowByPaneHandle('local', handle);
    expect(driver.refFromPaneHandle).toHaveBeenCalledTimes(1);

    await resolver.resolveWindowByPaneHandle('local', handle);
    expect(driver.refFromPaneHandle).toHaveBeenCalledTimes(1);
  });

  describe('getCached', () => {
    it('returns undefined on cache miss', () => {
      const resolver = new PaneHandleResolver(makeMuxDriverRegistry(), makeWindowRepo(), makeServerRepo());
      expect(resolver.getCached('local', handle)).toBeUndefined();
    });

    it('returns result on cache hit', async () => {
      const resolver = new PaneHandleResolver(
        makeMuxDriverRegistry({ ref, ordinal: 0 }),
        makeWindowRepo(win),
        makeServerRepo(),
      );
      await resolver.resolveWindowByPaneHandle('local', handle);
      const cached = resolver.getCached('local', handle);
      expect(cached).toEqual({ windowId: 10, ref, ordinal: 0, tmuxTarget: 'sess:win' });
    });

    it('returns null on negative cache hit', async () => {
      const resolver = new PaneHandleResolver(
        makeMuxDriverRegistry(null),
        makeWindowRepo(),
        makeServerRepo(),
      );
      await resolver.resolveWindowByPaneHandle('local', handle);
      expect(resolver.getCached('local', handle)).toBeNull();
    });
  });

  describe('invalidate', () => {
    it('clears cache for the given server', async () => {
      const muxRegistry = makeMuxDriverRegistry({ ref, ordinal: 0 });
      const driver = muxRegistry.resolve();
      const resolver = new PaneHandleResolver(muxRegistry, makeWindowRepo(win), makeServerRepo());

      await resolver.resolveWindowByPaneHandle('local', handle);
      expect(driver.refFromPaneHandle).toHaveBeenCalledTimes(1);

      resolver.invalidate('local');
      expect(resolver.getCached('local', handle)).toBeUndefined();
    });

    it('does not affect other servers', async () => {
      const resolver = new PaneHandleResolver(
        makeMuxDriverRegistry({ ref, ordinal: 0 }),
        makeWindowRepo(win),
        makeServerRepo(),
      );
      await resolver.resolveWindowByPaneHandle('local', handle);
      resolver.invalidate('remote');
      expect(resolver.getCached('local', handle)).not.toBeUndefined();
    });
  });

  describe('clearServer', () => {
    it('clears cache for the given server (alias for invalidate)', async () => {
      const resolver = new PaneHandleResolver(
        makeMuxDriverRegistry({ ref, ordinal: 0 }),
        makeWindowRepo(win),
        makeServerRepo(),
      );
      await resolver.resolveWindowByPaneHandle('local', handle);
      resolver.clearServer('local');
      expect(resolver.getCached('local', handle)).toBeUndefined();
    });
  });

  describe('warm', () => {
    it('populates cache so getCached hits afterward', async () => {
      const resolver = new PaneHandleResolver(
        makeMuxDriverRegistry({ ref, ordinal: 0 }),
        makeWindowRepo(win),
        makeServerRepo(),
      );
      resolver.warm('local', '%42');
      // warm is fire-and-forget — wait for microtask to complete
      await new Promise((r) => setTimeout(r, 10));
      const cached = resolver.getCached('local', handle);
      expect(cached).toEqual({ windowId: 10, ref, ordinal: 0, tmuxTarget: 'sess:win' });
    });
  });
});
