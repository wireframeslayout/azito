import { describe, it, expect, vi } from 'vitest';
import { measureWindowResources } from './windowResources';
import type { ServerConfig } from '../Server';
import type { MuxRef } from '@azito/shared';

const server = { name: 'local', type: 'local', muxRuntime: 'system' } as ServerConfig;

function ref(session: string, window: string): MuxRef {
  return { kind: 'tmux', workspace: session, window };
}

function makeMux(entries: Array<{ ref: MuxRef; pid: number }>) {
  return { measurePanePids: vi.fn(async () => entries) };
}

function makeTransport(ps: { stdout: string; code: number }) {
  return {
    exec: vi.fn(async () => ({ stdout: ps.stdout, stderr: '', code: ps.code })),
  } as never;
}

describe('measureWindowResources', () => {
  it('returns empty when measurePanePids returns nothing', async () => {
    const t = makeTransport({ stdout: '100 1 1024', code: 0 });
    const m = makeMux([]);
    expect(await measureWindowResources(t, m, server)).toEqual([]);
  });

  it('returns empty when ps command fails', async () => {
    const t = makeTransport({ stdout: '', code: 1 });
    const m = makeMux([{ ref: ref('sess', 'win1'), pid: 100 }]);
    expect(await measureWindowResources(t, m, server)).toEqual([]);
  });

  it('aggregates process tree RSS for a single window', async () => {
    const ps = ['100 1 1024', '200 100 2048', '300 200 512'].join('\n');
    const t = makeTransport({ stdout: ps, code: 0 });
    const m = makeMux([{ ref: ref('claude', 'win1'), pid: 100 }]);
    const result = await measureWindowResources(t, m, server);

    expect(result).toHaveLength(1);
    expect(result[0].target).toBe('claude:win1');
    expect(result[0].rssBytes).toBe((1024 + 2048 + 512) * 1024);
  });

  it('merges panes of the same window', async () => {
    const ps = '100 1 500\n200 1 300';
    const t = makeTransport({ stdout: ps, code: 0 });
    const m = makeMux([
      { ref: ref('sess', 'win1'), pid: 100 },
      { ref: ref('sess', 'win1'), pid: 200 },
    ]);
    const result = await measureWindowResources(t, m, server);

    expect(result).toHaveLength(1);
    expect(result[0].rssBytes).toBe((500 + 300) * 1024);
  });

  it('returns results sorted by rssBytes descending', async () => {
    const ps = '100 1 100\n200 1 500';
    const t = makeTransport({ stdout: ps, code: 0 });
    const m = makeMux([
      { ref: ref('sess', 'win1'), pid: 100 },
      { ref: ref('sess', 'win2'), pid: 200 },
    ]);
    const result = await measureWindowResources(t, m, server);

    expect(result).toHaveLength(2);
    expect(result[0].target).toBe('sess:win2');
    expect(result[1].target).toBe('sess:win1');
  });

  it('handles pane PID not found in ps output', async () => {
    const ps = '100 1 1024';
    const t = makeTransport({ stdout: ps, code: 0 });
    const m = makeMux([{ ref: ref('sess', 'win1'), pid: 999 }]);
    const result = await measureWindowResources(t, m, server);

    expect(result).toHaveLength(1);
    expect(result[0].rssBytes).toBe(0);
  });

  it('keeps a dot in the window name', async () => {
    const ps = '100 1 256';
    const t = makeTransport({ stdout: ps, code: 0 });
    const m = makeMux([{ ref: ref('sess', 'app.v2'), pid: 100 }]);
    const result = await measureWindowResources(t, m, server);

    expect(result[0].target).toBe('sess:app.v2');
  });
});
