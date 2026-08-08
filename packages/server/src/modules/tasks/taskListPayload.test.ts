import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import tasksRoutes from './routes';
import type { TasksRouteOptions } from './routes';
import type { Task } from './Task';

/**
 * The task list is fetched on every project switch and, at a few hundred tasks,
 * these four documents made up ~97% of a 3.5 MB response — enough to dominate
 * first paint on mobile networks. They must stay out of the list; the detail
 * panel reads them from `GET /api/tasks/:id`.
 */
const HEAVY_FIELDS = ['planMarkdown', 'description', 'summaryJson', 'changedFiles'] as const;

function makeTask(id: number): Task {
  return {
    id,
    projectId: 10,
    unitId: 20,
    serverName: 'test-server',
    title: `Task ${id}`,
    description: 'a'.repeat(500),
    status: 'open',
    currentPhase: null,
    selfReviewCount: 0,
    priority: 0,
    tmuxWindow: `task-${id}`,
    selfReviewMaxAttempts: null,
    requirePlanApproval: false,
    source: 'local',
    sourceRef: null,
    worktreePath: null,
    worktreeBranch: null,
    baseBranch: 'main',
    targetBranch: null,
    skipPr: false,
    workingDirectory: null,
    branch: null,
    planMarkdown: 'b'.repeat(500),
    pendingQuestions: null,
    changedFiles: '[]',
    summaryJson: '{}',
    prUrl: null,
    agentSessionId: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  } as Task;
}

function makeOpts(tasks: Task[], findByTaskIds = vi.fn(() => new Map())): TasksRouteOptions {
  return {
    taskRepo: {
      findAll: vi.fn(() => tasks),
      findByProject: vi.fn(() => tasks),
      findByUnit: vi.fn(() => tasks),
      findByStatus: vi.fn(() => tasks),
      findById: vi.fn(() => tasks[0]),
    },
    windowRepo: {
      findByTask: vi.fn(() => []),
      findByTaskIds,
    },
  } as unknown as TasksRouteOptions;
}

describe('GET /api/tasks payload', () => {
  it('omits the detail-only documents from every list item', async () => {
    const app = Fastify();
    await app.register(tasksRoutes, makeOpts([makeTask(1), makeTask(2)]));

    const res = await app.inject({ method: 'GET', url: '/api/tasks' });
    expect(res.statusCode).toBe(200);

    const items = res.json() as Record<string, unknown>[];
    expect(items).toHaveLength(2);
    for (const item of items) {
      for (const field of HEAVY_FIELDS) {
        expect(item).not.toHaveProperty(field);
      }
    }
  });

  it('keeps the fields the list actually renders', async () => {
    const app = Fastify();
    await app.register(tasksRoutes, makeOpts([makeTask(7)]));

    const [item] = (await app.inject({ method: 'GET', url: '/api/tasks' })).json() as Record<string, unknown>[];
    expect(item.id).toBe(7);
    expect(item.title).toBe('Task 7');
    expect(item.status).toBe('open');
    expect(item.projectId).toBe(10);
    expect(item.windows).toEqual([]);
  });

  it('resolves windows in one batched lookup rather than per task', async () => {
    const findByTaskIds = vi.fn(() => new Map());
    const opts = makeOpts([makeTask(1), makeTask(2), makeTask(3)], findByTaskIds);
    const app = Fastify();
    await app.register(tasksRoutes, opts);

    await app.inject({ method: 'GET', url: '/api/tasks' });

    expect(findByTaskIds).toHaveBeenCalledTimes(1);
    expect(findByTaskIds).toHaveBeenCalledWith([1, 2, 3]);
    // The per-task lookup is what made this an N+1 in the first place.
    expect(opts.windowRepo.findByTask).not.toHaveBeenCalled();
  });
});
