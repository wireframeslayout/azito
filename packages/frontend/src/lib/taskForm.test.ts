import { describe, it, expect } from 'vitest';
import { emptyTaskForm, buildTaskPayload, compareExecutionApprovalContext } from './taskForm';
import type { DisplayedExecutionContext } from './taskForm';

describe('buildTaskPayload (edit mode)', () => {
  it('omits status when unchanged from the loaded original', () => {
    const original = emptyTaskForm({ title: 'Task', status: 'pending_approval' });
    // form equals original except the description was edited
    const form = { ...original, description: 'edited body' };

    const payload = buildTaskPayload(form, 'edit', original);

    expect(payload).not.toHaveProperty('status');
    expect(payload.description).toBe('edited body');
  });

  it('includes status when the user actually changed it', () => {
    const original = emptyTaskForm({ title: 'Task', status: 'open' });
    const form = { ...original, status: 'done' };

    const payload = buildTaskPayload(form, 'edit', original);

    expect(payload.status).toBe('done');
  });

  it('includes status when no original snapshot is available (backward-compat fallback)', () => {
    const form = emptyTaskForm({ title: 'Task', status: 'open' });

    const payload = buildTaskPayload(form, 'edit');

    expect(payload.status).toBe('open');
  });

  it('still sends other edited fields regardless of status', () => {
    const original = emptyTaskForm({ title: 'Task', status: 'pending_approval', workingDirectory: '/old' });
    const form = { ...original, workingDirectory: '/new' };

    const payload = buildTaskPayload(form, 'edit', original);

    expect(payload.working_directory).toBe('/new');
    expect(payload).not.toHaveProperty('status');
  });
});

describe('buildTaskPayload (create mode)', () => {
  it('does not include a status field at all', () => {
    const form = emptyTaskForm({ projectId: '1', title: 'Task' });

    const payload = buildTaskPayload(form, 'create');

    expect(payload).not.toHaveProperty('status');
  });
});

// Third-party review fix (task/328-input-trust-and-exec-gate follow-up):
// the create-form's pre-approval banner must never approve content the
// human didn't actually see. compareExecutionApprovalContext is the gate
// between "banner displayed X" and "server will actually run Y" — only an
// exact match on every compared field may pre-approve.
describe('compareExecutionApprovalContext', () => {
  function makeContext(overrides: Partial<DisplayedExecutionContext> = {}): DisplayedExecutionContext {
    return {
      title: 'Fix the bug',
      description: 'Steps to reproduce...',
      unitId: 1,
      unitName: 'Default Unit',
      serverName: 'prod-1',
      workingDirectory: '/srv/app',
      branches: { base: 'main', target: 'main', work: 'task/1-fix' },
      phases: ['planning', 'implementing', 'reviewing'],
      repository: { owner: 'acme', repoName: 'widgets' },
      secretNames: ['DEPLOY_KEY', 'NPM_TOKEN'],
      ...overrides,
    };
  }

  it('matches when every compared field is identical', () => {
    const displayed = makeContext();
    const actual = makeContext();
    expect(compareExecutionApprovalContext(displayed, actual)).toEqual({ matches: true });
  });

  it('matches when secretNames differ only in order (compared as a set)', () => {
    const displayed = makeContext({ secretNames: ['NPM_TOKEN', 'DEPLOY_KEY'] });
    const actual = makeContext({ secretNames: ['DEPLOY_KEY', 'NPM_TOKEN'] });
    expect(compareExecutionApprovalContext(displayed, actual)).toEqual({ matches: true });
  });

  it('reports a mismatch when the resolved server differs from the displayed one', () => {
    const displayed = makeContext({ serverName: 'prod-1' });
    const actual = makeContext({ serverName: 'prod-2' });
    const result = compareExecutionApprovalContext(displayed, actual);
    expect(result.matches).toBe(false);
    expect((result as { mismatches: string[] }).mismatches).toContain('serverName');
  });

  it('reports a mismatch when the resolved working directory differs (server-side default applied)', () => {
    const displayed = makeContext({ workingDirectory: null });
    const actual = makeContext({ workingDirectory: '/srv/app-default' });
    const result = compareExecutionApprovalContext(displayed, actual);
    expect(result.matches).toBe(false);
    expect((result as { mismatches: string[] }).mismatches).toContain('workingDirectory');
  });

  it('reports a mismatch when the enabled phase list differs', () => {
    const displayed = makeContext({ phases: ['planning', 'implementing', 'reviewing'] });
    const actual = makeContext({ phases: ['planning', 'implementing'] });
    const result = compareExecutionApprovalContext(displayed, actual);
    expect(result.matches).toBe(false);
    expect((result as { mismatches: string[] }).mismatches).toContain('phases');
  });

  it('reports a mismatch when the PR destination repository differs', () => {
    const displayed = makeContext({ repository: { owner: 'acme', repoName: 'widgets' } });
    const actual = makeContext({ repository: { owner: 'acme', repoName: 'other-repo' } });
    const result = compareExecutionApprovalContext(displayed, actual);
    expect(result.matches).toBe(false);
    expect((result as { mismatches: string[] }).mismatches).toContain('repository');
  });

  it('reports a mismatch when the secret name set differs', () => {
    const displayed = makeContext({ secretNames: ['DEPLOY_KEY'] });
    const actual = makeContext({ secretNames: ['DEPLOY_KEY', 'NPM_TOKEN'] });
    const result = compareExecutionApprovalContext(displayed, actual);
    expect(result.matches).toBe(false);
    expect((result as { mismatches: string[] }).mismatches).toContain('secretNames');
  });

  it('reports a mismatch when the resolved Unit differs (project default Unit swapped between banner display and creation)', () => {
    // Same phase name (e.g. both Units enable 'implementing') would pass a
    // phase-only comparison even though workerType/systemPrompt differ
    // between the two Units — this is exactly the gap the third-party review
    // flagged: the banner shows unitName (TaskFormView.tsx) but the old
    // comparison never checked it.
    const displayed = makeContext({ unitId: 1, unitName: 'Safe Unit' });
    const actual = makeContext({ unitId: 2, unitName: 'Other Unit' });
    const result = compareExecutionApprovalContext(displayed, actual);
    expect(result.matches).toBe(false);
    expect((result as { mismatches: string[] }).mismatches).toContain('unit');
  });

  it('reports a mismatch when the Unit id is the same but the display name differs (defensive: name drift without id drift should still surface)', () => {
    const displayed = makeContext({ unitId: 1, unitName: 'Old Name' });
    const actual = makeContext({ unitId: 1, unitName: 'Renamed Unit' });
    const result = compareExecutionApprovalContext(displayed, actual);
    expect(result.matches).toBe(false);
    expect((result as { mismatches: string[] }).mismatches).toContain('unit');
  });

  it('reports a mismatch when branches differ', () => {
    const displayed = makeContext({ branches: { base: 'main', target: 'main', work: 'task/1' } });
    const actual = makeContext({ branches: { base: 'develop', target: 'main', work: 'task/1' } });
    const result = compareExecutionApprovalContext(displayed, actual);
    expect(result.matches).toBe(false);
    expect((result as { mismatches: string[] }).mismatches).toContain('baseBranch');
  });

  it('reports all mismatches at once, not just the first', () => {
    const displayed = makeContext();
    const actual = makeContext({ serverName: 'other', workingDirectory: '/other' });
    const result = compareExecutionApprovalContext(displayed, actual);
    expect(result.matches).toBe(false);
    expect((result as { mismatches: string[] }).mismatches).toEqual(expect.arrayContaining(['serverName', 'workingDirectory']));
  });
});
