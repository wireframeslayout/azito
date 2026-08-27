import { describe, it, expect } from 'vitest';
import { taskPushUrl, agentPushUrl } from './pushLinks';

describe('taskPushUrl', () => {
  it('returns /workspace/:projectId?task=:taskId', () => {
    expect(taskPushUrl(3, 42)).toBe('/workspace/3?task=42');
  });

  it('never returns bare /workspace or /tasks', () => {
    const url = taskPushUrl(1, 1);
    expect(url).not.toBe('/workspace');
    expect(url).not.toBe('/tasks');
    expect(url).toContain('?task=');
  });
});

describe('agentPushUrl', () => {
  it('returns /workspace/:projectId?server=&target= when projectId is present', () => {
    const url = agentPushUrl({ projectId: 5, serverName: 'srv1', target: 'main:0' });
    expect(url).toBe('/workspace/5?server=srv1&target=main%3A0');
  });

  it('returns /?server=&target= when projectId is absent', () => {
    const url = agentPushUrl({ serverName: 'srv1', target: 'main:0' });
    expect(url).toBe('/?server=srv1&target=main%3A0');
  });

  it('never returns bare /workspace or /tasks', () => {
    const withProject = agentPushUrl({ projectId: 1, serverName: 's', target: 't' });
    const withoutProject = agentPushUrl({ serverName: 's', target: 't' });
    for (const url of [withProject, withoutProject]) {
      expect(url).not.toBe('/workspace');
      expect(url).not.toBe('/tasks');
      expect(url).toContain('server=');
      expect(url).toContain('target=');
    }
  });
});
