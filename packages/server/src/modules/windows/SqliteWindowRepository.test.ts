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

    const found = repo.findByServerAndSession('local-server', 'azito');
    expect(found).toHaveLength(2);
    expect(found.map((w) => w.tmuxTarget).sort()).toEqual(['azito:extra', 'azito:task-1']);
  });

  it('does not match a different session sharing a name prefix', () => {
    repo.add(baseWindow({ projectId, tmuxTarget: 'azito-other:win1' }));

    const found = repo.findByServerAndSession('local-server', 'azito');
    expect(found).toHaveLength(0);
  });

  it('does not match windows on a different server', () => {
    repo.add(baseWindow({ projectId, serverName: 'other-server', tmuxTarget: 'azito:win1' }));

    const found = repo.findByServerAndSession('local-server', 'azito');
    expect(found).toHaveLength(0);
  });

  it('returns an empty array when the session has no windows', () => {
    expect(repo.findByServerAndSession('local-server', 'azito')).toEqual([]);
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
