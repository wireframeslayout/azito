import { describe, it, expect } from 'vitest';
import { findTaskByTarget } from './findTaskByTarget';

describe('findTaskByTarget', () => {
  const tasks = [
    { id: 1, tmuxWindow: '0' },
    { id: 5, tmuxWindow: '3' },
    { id: 10, tmuxWindow: 'build' },
  ];

  it('legacy session:window format', () => {
    expect(findTaskByTarget('mysession:0', tasks, new Map())).toEqual({ id: 1, tmuxWindow: '0' });
  });

  it('legacy format with pane suffix', () => {
    expect(findTaskByTarget('mysession:0.2', tasks, new Map())).toEqual({ id: 1, tmuxWindow: '0' });
  });

  it('w<id> format finds task via windowById', () => {
    const windowById = new Map([[42, { taskId: 5 }]]);
    expect(findTaskByTarget('w42', tasks, windowById)).toEqual({ id: 5, tmuxWindow: '3' });
  });

  it('w<id> with missing window returns null', () => {
    expect(findTaskByTarget('w999', tasks, new Map())).toBeNull();
  });

  it('w<id> with window but no taskId returns null', () => {
    const windowById = new Map<number, { taskId?: number }>([[42, {}]]);
    expect(findTaskByTarget('w42', tasks, windowById)).toBeNull();
  });

  it('unparseable string returns null', () => {
    expect(findTaskByTarget('foobar', tasks, new Map())).toBeNull();
  });

  it('empty string returns null', () => {
    expect(findTaskByTarget('', tasks, new Map())).toBeNull();
  });

  it('w0 boundary: window id 0 resolves correctly', () => {
    const windowById = new Map([[0, { taskId: 1 }]]);
    expect(findTaskByTarget('w0', tasks, windowById)).toEqual({ id: 1, tmuxWindow: '0' });
  });
});
