import { describe, it, expect } from 'vitest';
import { taskPushUrl, agentPushUrl, agentActivityPushUrl } from './pushLinks';

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

describe('agentActivityPushUrl', () => {
  it('carries the windowId so a misao window opens by id', () => {
    expect(agentActivityPushUrl({ projectId: 5, serverName: 'srv1', target: 'ws:w_01', windowId: 9 }, () => undefined))
      .toBe('/workspace/5?server=srv1&target=ws%3Aw_01&windowId=9');
  });

  it('takes the project from the task when the event has none, and omits windowId when unknown', () => {
    expect(agentActivityPushUrl({ taskId: 3, serverName: 's', target: 't' }, (id) => (id === 3 ? 7 : undefined)))
      .toBe('/workspace/7?server=s&target=t');
    expect(agentActivityPushUrl({ taskId: 4, serverName: 's', target: 't' }, () => undefined)).toBe('/?server=s&target=t');
  });
});
