import { describe, it, expect } from 'vitest';
import { getPushMessage } from './pushCatalog';
import type { PushMessageKey } from './pushCatalog';

describe('pushCatalog', () => {
  const ALL_KEYS: PushMessageKey[] = [
    'test', 'task.done', 'task.error', 'task.stoppedByUser',
    'task.sendError', 'task.codexError', 'task.waitingForHuman',
    'task.phaseReview', 'agent.finished', 'agent.approvalRequired', 'agent.idle',
  ];

  it('ja and en catalogs have the same keys', () => {
    for (const key of ALL_KEYS) {
      const en = getPushMessage('en', key);
      const ja = getPushMessage('ja', key);
      expect(en.title).toBeTruthy();
      expect(en.body).toBeTruthy();
      expect(ja.title).toBeTruthy();
      expect(ja.body).toBeTruthy();
    }
  });

  it('interpolates params correctly', () => {
    const en = getPushMessage('en', 'task.done', { taskTitle: 'My Task' });
    expect(en.body).toBe('Task "My Task" completed successfully');

    const ja = getPushMessage('ja', 'task.done', { taskTitle: 'My Task' });
    expect(ja.body).toBe('タスク「My Task」が正常に完了しました');
  });

  it('interpolates agent messages with label and serverName', () => {
    const en = getPushMessage('en', 'agent.finished', { label: 'claude', serverName: 'dev01' });
    expect(en.body).toBe('claude on dev01 finished');

    const ja = getPushMessage('ja', 'agent.finished', { label: 'claude', serverName: 'dev01' });
    expect(ja.body).toBe('claude（dev01）が完了しました');
  });

  it('falls back to en for unknown lang', () => {
    const result = getPushMessage('fr', 'test');
    expect(result.title).toBe('AZITO: Test Notification');
  });

  it('falls back to en for empty lang', () => {
    const result = getPushMessage('', 'test');
    expect(result.title).toBe('AZITO: Test Notification');
  });
});
