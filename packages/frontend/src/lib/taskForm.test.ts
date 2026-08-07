import { describe, it, expect } from 'vitest';
import { emptyTaskForm, buildTaskPayload } from './taskForm';

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
