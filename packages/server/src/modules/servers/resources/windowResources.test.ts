import { describe, it, expect, vi } from 'vitest';
import { measureWindowResources } from './windowResources';

function makeTransport(panes: { stdout: string; code: number }, ps: { stdout: string; code: number }) {
  let call = 0;
  return {
    exec: vi.fn(async () => {
      call++;
      return call === 1
        ? { stdout: panes.stdout, stderr: '', code: panes.code }
        : { stdout: ps.stdout, stderr: '', code: ps.code };
    }),
  } as never;
}

describe('measureWindowResources', () => {
  it('returns empty when tmux command fails', async () => {
    const t = makeTransport({ stdout: '', code: 1 }, { stdout: '', code: 0 });
    expect(await measureWindowResources(t)).toEqual([]);
  });

  it('returns empty when ps command fails', async () => {
    const t = makeTransport({ stdout: 'sess:win 100', code: 0 }, { stdout: '', code: 1 });
    expect(await measureWindowResources(t)).toEqual([]);
  });

  it('returns empty when no panes found', async () => {
    const t = makeTransport({ stdout: '', code: 0 }, { stdout: '100 1 1024', code: 0 });
    expect(await measureWindowResources(t)).toEqual([]);
  });

  it('aggregates process tree RSS for a single window', async () => {
    const panes = 'claude:win1 100';
    // pid 100 (1024KB) -> pid 200 (2048KB) -> pid 300 (512KB)
    const ps = [
      '100 1 1024',
      '200 100 2048',
      '300 200 512',
    ].join('\n');

    const t = makeTransport({ stdout: panes, code: 0 }, { stdout: ps, code: 0 });
    const result = await measureWindowResources(t);

    expect(result).toHaveLength(1);
    expect(result[0].target).toBe('claude:win1');
    expect(result[0].rssBytes).toBe((1024 + 2048 + 512) * 1024);
  });

  it('merges panes of the same window', async () => {
    // Two panes in the same window (different pane indices stripped)
    const panes = 'sess:win1 100\nsess:win1 200';
    const ps = '100 1 500\n200 1 300';

    const t = makeTransport({ stdout: panes, code: 0 }, { stdout: ps, code: 0 });
    const result = await measureWindowResources(t);

    expect(result).toHaveLength(1);
    expect(result[0].rssBytes).toBe((500 + 300) * 1024);
  });

  it('returns results sorted by rssBytes descending', async () => {
    const panes = 'sess:win1 100\nsess:win2 200';
    const ps = '100 1 100\n200 1 500';

    const t = makeTransport({ stdout: panes, code: 0 }, { stdout: ps, code: 0 });
    const result = await measureWindowResources(t);

    expect(result).toHaveLength(2);
    expect(result[0].target).toBe('sess:win2');
    expect(result[1].target).toBe('sess:win1');
  });

  it('handles pane PID not found in ps output', async () => {
    const panes = 'sess:win1 999';
    const ps = '100 1 1024';

    const t = makeTransport({ stdout: panes, code: 0 }, { stdout: ps, code: 0 });
    const result = await measureWindowResources(t);

    expect(result).toHaveLength(1);
    expect(result[0].rssBytes).toBe(0);
  });

  it('counts a window linked into several sessions only once', async () => {
    // `tmux new-session -t azito` (one per browser tab) shares the same window
    // object, so list-panes reports the same pane pid under each session name.
    const panes = [
      'azito:win--4dlt 100',
      '_azito_azito_3_1785236740506:win--4dlt 100',
      '_azito_azito_9_1785236740999:win--4dlt 100',
    ].join('\n');
    const ps = '100 1 512';

    const t = makeTransport({ stdout: panes, code: 0 }, { stdout: ps, code: 0 });
    const result = await measureWindowResources(t);

    expect(result).toHaveLength(1);
    expect(result[0].rssBytes).toBe(512 * 1024);
  });

  it.each([
    ['linked session listed first', '_azito_azito_3_1785236740506:win--4dlt 100\nazito:win--4dlt 100'],
    ['linked session listed last', 'azito:win--4dlt 100\n_azito_azito_3_1785236740506:win--4dlt 100'],
  ])('reports the source session name rather than a linked one (%s)', async (_label, panes) => {
    // Both orderings matter: tmux lists sessions alphabetically, so the linked
    // `_azito_*` name can come either side of the source depending on its name.
    const t = makeTransport({ stdout: panes, code: 0 }, { stdout: '100 1 512', code: 0 });
    const result = await measureWindowResources(t);

    expect(result[0].target).toBe('azito:win--4dlt');
  });

  it('keeps a dot in the window name instead of truncating it', async () => {
    // The tmux format carries no pane suffix, so 'sess:app.v2' is a window
    // literally named 'app.v2' — splitting on '.' would report 'sess:app'
    // and let a delete action target a different window.
    const panes = 'sess:app.v2 100';
    const ps = '100 1 256';

    const t = makeTransport({ stdout: panes, code: 0 }, { stdout: ps, code: 0 });
    const result = await measureWindowResources(t);

    expect(result[0].target).toBe('sess:app.v2');
  });
});
