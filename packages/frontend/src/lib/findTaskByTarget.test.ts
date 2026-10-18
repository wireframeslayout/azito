import { describe, it, expect } from 'vitest';
import { findTaskByTarget } from './findTaskByTarget';
import type { MuxRef } from '@azito/shared';

describe('findTaskByTarget', () => {
  const tasks = [
    { id: 1, tmuxWindow: '0' },
    { id: 5, tmuxWindow: '3' },
    { id: 10, tmuxWindow: 'build' },
  ];

  it('legacy session:window format', () => {
    expect(findTaskByTarget('mysession:0', [tasks], new Map())).toEqual({ id: 1, tmuxWindow: '0' });
  });

  it('legacy format with pane suffix', () => {
    expect(findTaskByTarget('mysession:0.2', [tasks], new Map())).toEqual({ id: 1, tmuxWindow: '0' });
  });

  it('w<id> format finds task via windowById', () => {
    const windowById = new Map([[42, { taskId: 5 }]]);
    expect(findTaskByTarget('w42', [tasks], windowById)).toEqual({ id: 5, tmuxWindow: '3' });
  });

  it('w<id> with missing window returns null', () => {
    expect(findTaskByTarget('w999', [tasks], new Map())).toBeNull();
  });

  it('w<id> with window but no taskId returns null', () => {
    const windowById = new Map<number, { taskId?: number }>([[42, {}]]);
    expect(findTaskByTarget('w42', [tasks], windowById)).toBeNull();
  });

  it('unparseable string returns null', () => {
    expect(findTaskByTarget('foobar', [tasks], new Map())).toBeNull();
  });

  it('empty string returns null', () => {
    expect(findTaskByTarget('', [tasks], new Map())).toBeNull();
  });

  it('w0 boundary: window id 0 resolves correctly', () => {
    const windowById = new Map([[0, { taskId: 1 }]]);
    expect(findTaskByTarget('w0', [tasks], windowById)).toEqual({ id: 1, tmuxWindow: '0' });
  });

  it('prefers tasks in earlier list (project scope) over later list (all tasks)', () => {
    const projectTasks = [{ id: 100, tmuxWindow: '0' }];
    const globalTasks = [{ id: 200, tmuxWindow: '0' }, ...tasks];
    expect(findTaskByTarget('sess:0', [projectTasks, globalTasks], new Map())).toEqual({ id: 100, tmuxWindow: '0' });
  });

  it('falls through to later list when not found in earlier list', () => {
    const projectTasks = [{ id: 100, tmuxWindow: '5' }];
    expect(findTaskByTarget('sess:build', [projectTasks, tasks], new Map())).toEqual({ id: 10, tmuxWindow: 'build' });
  });

  it('JSON MuxRef format finds task via windowById muxRef match', () => {
    const ref: MuxRef = { kind: 'misao', workspace: 'default', window: 'w_0ABCDEFGHJKMNPQRSTVWXYZ012' };
    const target = JSON.stringify(ref);
    const windowById = new Map([[99, { taskId: 5, muxRef: ref }]]);
    expect(findTaskByTarget(target, [tasks], windowById)).toEqual({ id: 5, tmuxWindow: '3' });
  });

  it('JSON MuxRef with no matching window returns null', () => {
    const ref: MuxRef = { kind: 'misao', workspace: 'default', window: 'w_0ABCDEFGHJKMNPQRSTVWXYZ012' };
    const target = JSON.stringify(ref);
    expect(findTaskByTarget(target, [tasks], new Map())).toBeNull();
  });

  it('JSON MuxRef does not match different window id', () => {
    const ref: MuxRef = { kind: 'misao', workspace: 'default', window: 'w_0ABCDEFGHJKMNPQRSTVWXYZ012' };
    const otherRef: MuxRef = { kind: 'misao', workspace: 'default', window: 'w_1ABCDEFGHJKMNPQRSTVWXYZ999' };
    const target = JSON.stringify(ref);
    const windowById = new Map([[99, { taskId: 5, muxRef: otherRef }]]);
    expect(findTaskByTarget(target, [tasks], windowById)).toBeNull();
  });
});
