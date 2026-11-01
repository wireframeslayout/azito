import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { buildSeededDb, insertProject, insertTask } from './windowTestDb';

import { SqliteWindowRepository } from './SqliteWindowRepository';
import type { Window } from './Window';

function baseWindow(overrides: Partial<Omit<Window, 'id' | 'createdAt'>> = {}): Omit<Window, 'id' | 'createdAt'> {
  return {
    ownerType: 'project',
    projectId: null,
    taskId: null,
    serverName: 'local-server',
    tmuxTarget: 'proj:win1',
    label: null,
    labelSource: 'auto',
    isPrimary: false,
    windowType: 'terminal',
    workerType: null,
    workerModel: null,
    agentSessionId: null,
    launchCommand: null,
    workingDirectory: null,
    paneLayout: null,
    sleeping: false,
    ...overrides,
  };
}

describe('SqliteWindowRepository.findByServerAndTarget', () => {
  let db: Database.Database;
  let repo: SqliteWindowRepository;
  let projectId: number;

  beforeEach(() => {
    db = buildSeededDb();
    repo = new SqliteWindowRepository(db);
    projectId = insertProject(db, 'Test Project');
  });

  it('returns undefined when no row matches', () => {
    expect(repo.findByServerAndTarget('local-server', 'proj:win1')).toBeUndefined();
  });

  it('matches window-granularity even when the request target carries a pane suffix', () => {
    repo.add(baseWindow({ projectId, tmuxTarget: 'proj:win1' }));
    const found = repo.findByServerAndTarget('local-server', 'proj:win1.1');
    expect(found?.tmuxTarget).toBe('proj:win1');
  });

  it('returns the task-owning row for a task target', () => {
    const taskA = insertTask(db, projectId, 'Task A');
    repo.add(baseWindow({ ownerType: 'task', projectId: null, taskId: taskA, tmuxTarget: 'proj:win1' }));

    const found = repo.findByServerAndTarget('local-server', 'proj:win1');
    expect(found?.taskId).toBe(taskA);
    expect(found?.ownerType).toBe('task');
  });

  it('returns the project-owning row for a project target', () => {
    repo.add(baseWindow({ projectId, tmuxTarget: 'proj:win1' }));

    const found = repo.findByServerAndTarget('local-server', 'proj:win1');
    expect(found?.ownerType).toBe('project');
  });

  it('distinguishes different targets on the same server', () => {
    const taskA = insertTask(db, projectId, 'Task A');
    repo.add(baseWindow({ projectId, tmuxTarget: 'proj:win-project' }));
    repo.add(baseWindow({ ownerType: 'task', projectId: null, taskId: taskA, tmuxTarget: 'proj:win-task' }));

    expect(repo.findByServerAndTarget('local-server', 'proj:win-task')?.taskId).toBe(taskA);
    expect(repo.findByServerAndTarget('local-server', 'proj:win-project')?.ownerType).toBe('project');
  });
});

// Issue #28 third-party review finding 4: the session-delete route needs to
// resolve every window a session holds (any ownerType) BEFORE killing it —
// this is the query that powers that lookup.
describe('SqliteWindowRepository.findByServerAndSession', () => {
  let db: Database.Database;
  let repo: SqliteWindowRepository;
  let projectId: number;

  beforeEach(() => {
    db = buildSeededDb();
    repo = new SqliteWindowRepository(db);
    projectId = insertProject(db, 'Test Project');
  });

  it('returns every window (task-owned and project-owned) whose target belongs to the session', () => {
    const taskA = insertTask(db, projectId, 'Task A');
    repo.add(baseWindow({ ownerType: 'task', projectId: null, taskId: taskA, tmuxTarget: 'azito:task-1' }));
    repo.add(baseWindow({ projectId, tmuxTarget: 'azito:extra' }));

    const found = repo.findByServerAndSession('local-server', 'azito', 'tmux');
    expect(found).toHaveLength(2);
    expect(found.map((w) => w.tmuxTarget).sort()).toEqual(['azito:extra', 'azito:task-1']);
  });

  it('does not match a different session sharing a name prefix', () => {
    repo.add(baseWindow({ projectId, tmuxTarget: 'azito-other:win1' }));

    const found = repo.findByServerAndSession('local-server', 'azito', 'tmux');
    expect(found).toHaveLength(0);
  });

  it('does not match windows on a different server', () => {
    repo.add(baseWindow({ projectId, serverName: 'other-server', tmuxTarget: 'azito:win1' }));

    const found = repo.findByServerAndSession('local-server', 'azito', 'tmux');
    expect(found).toHaveLength(0);
  });

  it('returns an empty array when the session has no windows', () => {
    expect(repo.findByServerAndSession('local-server', 'azito', 'tmux')).toEqual([]);
  });

  it('tells a tmux session from a same-named misao workspace by the row kind', () => {
    repo.add(baseWindow({ projectId, tmuxTarget: 'azito:win1' }));
    const misaoRef = { kind: 'misao' as const, workspace: 'azito', window: 'w_01HZY0000000000000000000AA' };
    repo.add(baseWindow({ projectId, tmuxTarget: 'azito:w_01HZY0000000000000000000AA', muxRef: misaoRef }));

    expect(repo.findByServerAndSession('local-server', 'azito', 'tmux').map((w) => w.tmuxTarget)).toEqual(['azito:win1']);
    expect(repo.findByServerAndSession('local-server', 'azito', 'misao').map((w) => w.muxRef)).toEqual([misaoRef]);
  });
});

describe('SqliteWindowRepository misao tmux_target normalization', () => {
  let db: Database.Database;
  let repo: SqliteWindowRepository;
  let projectId: number;
  const misaoRef = { kind: 'misao' as const, workspace: 'ws', window: 'w_01HZY0000000000000000000AA' };

  beforeEach(() => {
    db = buildSeededDb();
    repo = new SqliteWindowRepository(db);
    projectId = insertProject(db, 'Test Project');
  });

  it('stores a misao window as <workspace>:<window id> whatever target it is added with', () => {
    const byOrdinal = repo.add(baseWindow({ projectId, tmuxTarget: 'ws:0', muxRef: misaoRef }));
    expect(repo.findById(byOrdinal)?.tmuxTarget).toBe('ws:w_01HZY0000000000000000000AA');
  });

  it('keeps a tmux window target as given', () => {
    const id = repo.add(baseWindow({ projectId, tmuxTarget: 'ws:0' }));
    expect(repo.findById(id)?.tmuxTarget).toBe('ws:0');
    expect(repo.findById(id)?.muxRef).toEqual({ kind: 'tmux', workspace: 'ws', window: '0' });
  });

  it('derives the target of a misao ref update from the ref (it used to throw)', () => {
    const id = repo.add(baseWindow({ projectId, tmuxTarget: 'ws:a' }));
    repo.update(id, { muxRef: misaoRef });
    expect(repo.findById(id)).toMatchObject({ tmuxTarget: 'ws:w_01HZY0000000000000000000AA', muxRef: misaoRef });
  });

  it('keeps a misao row misao on a target-only update', () => {
    const id = repo.add(baseWindow({ projectId, tmuxTarget: 'ws:w_01HZY0000000000000000000AA', muxRef: misaoRef }));
    repo.update(id, { tmuxTarget: 'renamed:w_01HZY0000000000000000000AA' });
    expect(repo.findById(id)?.muxRef).toEqual({ ...misaoRef, workspace: 'renamed' });
    expect(() => repo.update(id, { tmuxTarget: 'renamed:display-name' })).toThrow(/window id/);
  });
});

describe('SqliteWindowRepository.updateAgentSessionIdByWindow', () => {
  let db: Database.Database;
  let repo: SqliteWindowRepository;
  let projectId: number;

  beforeEach(() => {
    db = buildSeededDb();
    repo = new SqliteWindowRepository(db);
    projectId = insertProject(db, 'Test Project');
  });

  it('updates the matching window row', () => {
    const taskId = insertTask(db, projectId, 'Task A');
    const taskWinId = repo.add(baseWindow({ ownerType: 'task', projectId: null, taskId, tmuxTarget: 'proj:win1', windowType: 'agent', workerType: 'claude' }));

    repo.updateAgentSessionIdByWindow('local-server', 'proj:win1', 'test-session-uuid');

    expect(repo.findById(taskWinId)?.agentSessionId).toBe('test-session-uuid');
  });

  it('does not update a row with a different target', () => {
    const winId = repo.add(baseWindow({ projectId, tmuxTarget: 'proj:win-other', windowType: 'agent', workerType: 'claude' }));

    repo.updateAgentSessionIdByWindow('local-server', 'proj:win1', 'session-abc');

    expect(repo.findById(winId)?.agentSessionId).toBeNull();
  });

  it('does not update rows on a different server', () => {
    const winId = repo.add(baseWindow({ projectId, serverName: 'other-server', windowType: 'agent', workerType: 'claude' }));
    repo.add(baseWindow({ projectId, windowType: 'agent', workerType: 'claude' }));

    repo.updateAgentSessionIdByWindow('local-server', 'proj:win1', 'session-xyz');

    expect(repo.findById(winId)?.agentSessionId).toBeNull();
  });
});

// Attaching an existing project window to a task must convert the single row (068: one
// physical window = one row) instead of leaving it project-owned (win--qvp6 / task 368).
describe('SqliteWindowRepository.adoptForTask', () => {
  let db: Database.Database;
  let repo: SqliteWindowRepository;
  let projectId: number;

  beforeEach(() => {
    db = buildSeededDb();
    repo = new SqliteWindowRepository(db);
    projectId = insertProject(db, 'Test Project');
  });


  it('converts a project-owned row into a task-owned row and keeps project_id', () => {
    const taskA = insertTask(db, projectId, 'Task A');
    const id = repo.add(baseWindow({ projectId, tmuxTarget: 'azito:win--qvp6' }));
    repo.adoptForTask(id, taskA);
    const w = repo.findById(id)!;
    expect(w.ownerType).toBe('task');
    expect(w.taskId).toBe(taskA);
    expect(w.projectId).toBe(projectId);
    expect(repo.findByTask(taskA).map((x) => x.id)).toEqual([id]);
    expect(repo.findByServerAndTarget('local-server', 'azito:win--qvp6')?.id).toBe(id);
  });
});


describe('window label source', () => {
  it('defaults new rows to auto and persists user labels atomically', () => {
    const db = buildSeededDb();
    const repo = new SqliteWindowRepository(db);
    const projectId = insertProject(db, 'Labels');
    const id = repo.add(baseWindow({ projectId, label: 'generated' }));
    expect(repo.findById(id)?.labelSource).toBe('auto');
    repo.update(id, { label: 'chosen', labelSource: 'user' });
    expect(repo.findById(id)).toMatchObject({ label: 'chosen', labelSource: 'user' });
    repo.add(baseWindow({ projectId, label: 'generated again' }));
    expect(repo.findById(id)).toMatchObject({ label: 'chosen', labelSource: 'user' });
    expect(() => db.prepare("UPDATE windows SET label_source = 'invalid' WHERE id = ?").run(id)).toThrow();
    db.close();
  });
});

describe('Claude configuration directories', () => {
  it('preserves each pane session when capturing a layout and clears a changed window session', () => {
    const db = buildSeededDb();
    const repo = new SqliteWindowRepository(db);
    const projectId = insertProject(db, 'Claude');
    const id = repo.add(baseWindow({ projectId }));
    repo.updateClaudeSessionByPane('local-server', 'proj:win1', 1, 'first', '/first');
    repo.updateClaudeSessionByPane('local-server', 'proj:win1', 2, 'second', '/second');
    repo.updatePaneLayout(id, { layout: '', panes: [
      { index: 0, ordinal: 1, command: null, workingDirectory: null, title: null },
      { index: 1, ordinal: 2, command: null, workingDirectory: null, title: null },
    ] });
    expect(repo.findById(id)?.paneLayout?.panes.map((p) => [p.agentSessionId, p.claudeConfigDir])).toEqual([
      ['first', '/first'], ['second', '/second'],
    ]);
    repo.updateClaudeSessionByPane('local-server', 'proj:win1', 2, 'third', '/third');
    expect(repo.findById(id)?.paneLayout?.panes[1]).toMatchObject({ agentSessionId: 'third', claudeConfigDir: '/third' });
    repo.updateAgentSessionIdByWindow('local-server', 'proj:win1', 'new');
    expect(repo.findById(id)?.claudeConfigDir).toBeNull();
    expect(repo.findById(id)?.paneLayout?.panes[0]).toMatchObject({ agentSessionId: 'new' });
    expect(repo.findById(id)?.paneLayout?.panes[0].claudeConfigDir).toBeUndefined();
    db.close();
  });
});
