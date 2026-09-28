import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InteractionMonitor, type InteractionSignal } from './InteractionMonitor';
import type { IWindowRepository, Window } from '../windows/Window';

function makeWindow(overrides: Partial<Window> = {}): Window {
  return {
    id: 1,
    ownerType: 'project',
    projectId: 1,
    taskId: null,
    serverName: 'local',
    tmuxTarget: 'azito:agent-1.1',
    label: 'agent-1',
    isPrimary: false,
    windowType: 'agent',
    workerType: 'claude',
    workerModel: null,
    agentSessionId: null,
    launchCommand: null,
    workingDirectory: null,
    paneLayout: null,
    sleeping: false,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeSignal(overrides: Partial<InteractionSignal> = {}): InteractionSignal {
  return {
    serverName: 'local',
    target: { sessionName: 'azito', windowIndex: 1, windowName: 'agent-1', paneIndex: 1 },
    event: 'open',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('InteractionMonitor', () => {
  let findAll: ReturnType<typeof vi.fn<() => Window[]>>;
  let findById: ReturnType<typeof vi.fn<(id: number) => Window | undefined>>;
  let now: ReturnType<typeof vi.fn<() => number>>;
  let monitor: InteractionMonitor;

  beforeEach(() => {
    findAll = vi.fn<() => Window[]>().mockReturnValue([makeWindow()]);
    findById = vi.fn<(id: number) => Window | undefined>().mockReturnValue(makeWindow());
    now = vi.fn<() => number>().mockReturnValue(1_000_000);
    monitor = new InteractionMonitor(
      { findAll, findById } as unknown as IWindowRepository,
      now,
    );
  });

  it('is not pending before any signal', () => {
    expect(monitor.isPending(1)).toBe(false);
  });

  it('open -> pending, resolved against the windows table', () => {
    monitor.recordSignal(makeSignal({ timestamp: now() }));
    expect(monitor.isPending(1)).toBe(true);
  });

  it('is ignored when window resolution fails (no matching window)', () => {
    findAll.mockReturnValue([]);
    monitor.recordSignal(makeSignal({ timestamp: now() }));
    expect(monitor.isPending(1)).toBe(false);
  });

  it('is ignored when the signal names a different server', () => {
    monitor.recordSignal(makeSignal({ serverName: 'other', timestamp: now() }));
    expect(monitor.isPending(1)).toBe(false);
  });

  it('is ignored when the pane suffix does not match', () => {
    monitor.recordSignal(makeSignal({ target: { sessionName: 'azito', windowIndex: 1, windowName: 'agent-1', paneIndex: 2 }, timestamp: now() }));
    expect(monitor.isPending(1)).toBe(false);
  });

  it('times out after 10 minutes', () => {
    monitor.recordSignal(makeSignal({ timestamp: now() }));
    expect(monitor.isPending(1)).toBe(true);

    now.mockReturnValue(1_000_000 + 10 * 60 * 1000 - 1);
    expect(monitor.isPending(1)).toBe(true);

    now.mockReturnValue(1_000_000 + 10 * 60 * 1000);
    expect(monitor.isPending(1)).toBe(false);
  });

  it('clear() authoritatively closes a pending signal', () => {
    monitor.recordSignal(makeSignal({ timestamp: now() }));
    expect(monitor.isPending(1)).toBe(true);

    monitor.clear(1);
    expect(monitor.isPending(1)).toBe(false);
  });

  it('a cancel signal closes a pending open', () => {
    monitor.recordSignal(makeSignal({ event: 'open', timestamp: now() }));
    expect(monitor.isPending(1)).toBe(true);

    monitor.recordSignal(makeSignal({ event: 'cancel', timestamp: now() }));
    expect(monitor.isPending(1)).toBe(false);
  });

  it('is not pending once the window disappears from the windows table', () => {
    monitor.recordSignal(makeSignal({ timestamp: now() }));
    expect(monitor.isPending(1)).toBe(true);

    findById.mockReturnValue(undefined);
    expect(monitor.isPending(1)).toBe(false);
  });

  describe('sibling windows sharing the same tmux target', () => {
    // A project-owned window row and a task-owned window row can both point
    // at the same tmux target (same serverName+session+windowIndex+pane) —
    // the signal must mark both pending, and clearing either one must clear
    // both (mirrors AgentActivityMonitor.recordHookSignal's "every matching
    // row" behavior).
    function makeSiblingWindows(): Window[] {
      return [
        makeWindow({ id: 1, ownerType: 'project', tmuxTarget: 'azito:agent-1.1' }),
        makeWindow({ id: 2, ownerType: 'task', taskId: 5, tmuxTarget: 'azito:agent-1.1' }),
      ];
    }

    it('recordSignal marks every matching window pending, not just the first', () => {
      findAll.mockReturnValue(makeSiblingWindows());
      findById.mockImplementation((id: number) => makeSiblingWindows().find((w) => w.id === id));

      monitor.recordSignal(makeSignal({ timestamp: now() }));

      expect(monitor.isPending(1)).toBe(true);
      expect(monitor.isPending(2)).toBe(true);
    });

    it('clear(windowId) also clears sibling window IDs sharing the same tmux target', () => {
      findAll.mockReturnValue(makeSiblingWindows());
      findById.mockImplementation((id: number) => makeSiblingWindows().find((w) => w.id === id));

      monitor.recordSignal(makeSignal({ timestamp: now() }));
      expect(monitor.isPending(1)).toBe(true);
      expect(monitor.isPending(2)).toBe(true);

      monitor.clear(1);

      expect(monitor.isPending(1)).toBe(false);
      expect(monitor.isPending(2)).toBe(false);
    });

    it('clear(windowId) with no live pending entry is a no-op (falls back to clearing just that id)', () => {
      findAll.mockReturnValue(makeSiblingWindows());
      findById.mockImplementation((id: number) => makeSiblingWindows().find((w) => w.id === id));

      expect(() => monitor.clear(1)).not.toThrow();
      expect(monitor.isPending(1)).toBe(false);
      expect(monitor.isPending(2)).toBe(false);
    });
  });

  describe('getOpenedAt', () => {
    it('is undefined before any signal', () => {
      expect(monitor.getOpenedAt(1)).toBeUndefined();
    });

    it('returns the signal timestamp while pending', () => {
      monitor.recordSignal(makeSignal({ timestamp: 1_000_000 }));
      expect(monitor.getOpenedAt(1)).toBe(1_000_000);
    });

    it('is undefined after clear()', () => {
      monitor.recordSignal(makeSignal({ timestamp: now() }));
      monitor.clear(1);
      expect(monitor.getOpenedAt(1)).toBeUndefined();
    });

    it('is undefined after timeout, mirroring isPending', () => {
      monitor.recordSignal(makeSignal({ timestamp: now() }));
      now.mockReturnValue(1_000_000 + 10 * 60 * 1000);
      expect(monitor.getOpenedAt(1)).toBeUndefined();
    });
  });
  describe('質問内容（content）', () => {
    const content = {
      toolName: 'AskUserQuestion',
      questions: [{ question: 'どれ?', multiSelect: false, options: [{ label: 'はい' }, { label: 'いいえ' }] }],
    };

    it('content 付きシグナルの内容を保持する', () => {
      monitor.recordSignal(makeSignal({ timestamp: now(), content }));
      expect(monitor.getPendingContent(1)).toEqual(content);
    });

    it('content なしシグナルでは内容を持たない（バナーへ退化）', () => {
      monitor.recordSignal(makeSignal({ timestamp: now() }));
      expect(monitor.getPendingContent(1)).toBeUndefined();
    });

    it('後から来た content なしシグナルは保持済み content を消さない', () => {
      monitor.recordSignal(makeSignal({ timestamp: now(), content }));
      monitor.recordSignal(makeSignal({ timestamp: now() + 60_000 }));
      expect(monitor.getPendingContent(1)).toEqual(content);
      expect(monitor.getOpenedAt(1)).toBe(now() + 60_000);
    });

    it('content なしの後に content 付きが来たら内容で更新する', () => {
      monitor.recordSignal(makeSignal({ timestamp: now() }));
      monitor.recordSignal(makeSignal({ timestamp: now(), content }));
      expect(monitor.getPendingContent(1)).toEqual(content);
    });

    it('期限切れの content は引き継がない', () => {
      monitor.recordSignal(makeSignal({ timestamp: now(), content }));
      now.mockReturnValue(1_000_000 + 10 * 60 * 1000);
      monitor.recordSignal(makeSignal({ timestamp: now() }));
      expect(monitor.getPendingContent(1)).toBeUndefined();
    });
  });

  describe('consumePendingAnswer', () => {
    const content = {
      toolName: 'AskUserQuestion',
      questions: [{ question: 'どれ?', multiSelect: false, options: [{ label: 'はい' }, { label: 'いいえ' }] }],
    };
    /** makeSignal の既定ターゲット（paneIndex: 1）に対する、成立する claim。 */
    const claimFor = (openedAt: number, optionNumber = 1) => ({ openedAt, optionNumber, paneIndex: 1 });

    it('content 付き pending を1回だけ消費できる', () => {
      monitor.recordSignal(makeSignal({ timestamp: now(), content }));
      expect(monitor.consumePendingAnswer(1, claimFor(now()))).toBe(true);
      expect(monitor.consumePendingAnswer(1, claimFor(now()))).toBe(false);
      expect(monitor.isPending(1)).toBe(false);
    });

    it('content なしの pending は消費できない（数字キーを送る根拠が無い）', () => {
      monitor.recordSignal(makeSignal({ timestamp: now() }));
      expect(monitor.consumePendingAnswer(1, claimFor(now()))).toBe(false);
      expect(monitor.isPending(1)).toBe(true);
    });

    it('pending が無ければ false', () => {
      expect(monitor.consumePendingAnswer(1, claimFor(now()))).toBe(false);
    });

    it('世代（openedAt）が一致しない claim は消費できず、pending も消さない', () => {
      monitor.recordSignal(makeSignal({ timestamp: now(), content }));
      expect(monitor.consumePendingAnswer(1, claimFor(now() - 1))).toBe(false);
      expect(monitor.isPending(1)).toBe(true);
      expect(monitor.getPendingContent(1)).toEqual(content);
    });

    it('質問が差し替わった後に、古い世代の claim が新しい質問を消費してしまわない', () => {
      const firstOpenedAt = now();
      monitor.recordSignal(makeSignal({ timestamp: firstOpenedAt, content }));
      const secondContent = {
        toolName: 'AskUserQuestion',
        questions: [{ question: '次は?', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }],
      };
      monitor.recordSignal(makeSignal({ timestamp: firstOpenedAt + 5_000, content: secondContent }));

      expect(monitor.consumePendingAnswer(1, claimFor(firstOpenedAt))).toBe(false);
      expect(monitor.getPendingContent(1)).toEqual(secondContent);
      expect(monitor.consumePendingAnswer(1, claimFor(firstOpenedAt + 5_000))).toBe(true);
    });

    it('シグナル元と違うペインへの送出は消費できず、pending も消さない', () => {
      monitor.recordSignal(makeSignal({ timestamp: now(), content }));
      expect(monitor.consumePendingAnswer(1, { openedAt: now(), optionNumber: 1, paneIndex: 2 })).toBe(false);
      expect(monitor.isPending(1)).toBe(true);
    });

    it.each([[0], [3], [1.5]])('選択肢の範囲外・非整数の番号 %p は消費できない', (optionNumber) => {
      monitor.recordSignal(makeSignal({ timestamp: now(), content }));
      expect(monitor.consumePendingAnswer(1, claimFor(now(), optionNumber))).toBe(false);
      expect(monitor.isPending(1)).toBe(true);
    });

    it('multiSelect の質問は消費できない（数字キー1発では確定しない）', () => {
      monitor.recordSignal(makeSignal({
        timestamp: now(),
        content: { toolName: 'AskUserQuestion', questions: [{ ...content.questions[0], multiSelect: true }] },
      }));
      expect(monitor.consumePendingAnswer(1, claimFor(now()))).toBe(false);
      expect(monitor.isPending(1)).toBe(true);
    });

    it('質問が複数ある content は消費できない', () => {
      monitor.recordSignal(makeSignal({
        timestamp: now(),
        content: { toolName: 'AskUserQuestion', questions: [content.questions[0], content.questions[0]] },
      }));
      expect(monitor.consumePendingAnswer(1, claimFor(now()))).toBe(false);
    });

    it('AskUserQuestion 以外の tool の content は消費できない', () => {
      monitor.recordSignal(makeSignal({
        timestamp: now(),
        content: { ...content, toolName: 'SomeOtherTool' },
      }));
      expect(monitor.consumePendingAnswer(1, claimFor(now()))).toBe(false);
    });

    it('同じ tmux ターゲットを指す兄弟ウィンドウ行もまとめて消費する', () => {
      findAll.mockReturnValue([makeWindow(), makeWindow({ id: 2, ownerType: 'task', taskId: 5 })]);
      findById.mockImplementation((id) => makeWindow({ id }));
      monitor.recordSignal(makeSignal({ timestamp: now(), content }));
      expect(monitor.consumePendingAnswer(1, claimFor(now()))).toBe(true);
      expect(monitor.isPending(2)).toBe(false);
    });
  });
});
