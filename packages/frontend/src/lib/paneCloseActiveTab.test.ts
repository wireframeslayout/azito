import { describe, it, expect } from 'vitest';
import { resolveActiveTabAfterPaneClose } from './paneCloseActiveTab';

describe('resolveActiveTabAfterPaneClose', () => {
  it('閉じたタブがアクティブならペインの後継に切り替える', () => {
    expect(resolveActiveTabAfterPaneClose('task-form:new:1', 'task-form:new:1', 'terminal:pinned')).toBe('terminal:pinned');
  });
  it('確認待ちの間に開かれたタブを上書きしない', () => {
    expect(resolveActiveTabAfterPaneClose('task:42', 'task-form:new:1', 'terminal:pinned')).toBe('task:42');
  });
  it('後継がないときは prev を返し flat closeTab の fallback に任せる', () => {
    expect(resolveActiveTabAfterPaneClose('task-form:new:1', 'task-form:new:1', null)).toBe('task-form:new:1');
  });
});

describe('タスク作成後の自動遷移（回帰）', () => {
  it('ピン留めタブがあっても新しいタスクタブがアクティブのまま残る', () => {
    const closed = 'task-form:new:1';
    const queue: Array<(prev: string | null) => string | null> = [
      () => 'task:42',
      (prev) => resolveActiveTabAfterPaneClose(prev, closed, 'terminal:pinned'),
      (prev) => (prev !== closed ? prev : 'terminal:pinned'),
    ];
    expect(queue.reduce<string | null>((s, f) => f(s), closed)).toBe('task:42');
  });
});
