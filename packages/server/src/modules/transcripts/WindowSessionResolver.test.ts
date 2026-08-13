import { describe, it, expect, vi } from 'vitest';
import { WindowSessionResolver } from './WindowSessionResolver';
import type { ITaskRepository, Task } from '../tasks/Task';
import type { TmuxClient, TmuxPaneInfo, TmuxSession } from '../tmux/TmuxClient';
import type { IServerRepository, ServerConfig } from '../servers/Server';
import type { TranscriptSource, SessionSummary } from './sources/TranscriptSource';
import type { Window } from './../windows/Window';
import type { SessionCaptureService } from '../windows/SessionCaptureService';

const SID_CLAUDE = '11111111-1111-1111-1111-111111111111';
const SID_CODEX = '22222222-2222-2222-2222-222222222222';

const LOCAL_SERVER: ServerConfig = {
  name: 'local',
  type: 'local',
  host: null,
  agentPort: null,
  agentToken: null,
  agentVersion: null,
  sshHost: null,
  muxRuntime: 'system',
  sshHostFingerprint: null,
  createdAt: '2026-01-01T00:00:00Z',
};

const AGENT_SERVER: ServerConfig = { ...LOCAL_SERVER, name: 'agent1', type: 'agent' };

function buildWindow(overrides: Partial<Window> = {}): Window {
  return {
    id: 42,
    ownerType: 'task',
    projectId: 1,
    taskId: null,
    serverName: 'local',
    tmuxTarget: 'main:0',
    label: null,
    isPrimary: true,
    windowType: 'agent',
    workerType: 'claude',
    workerModel: null,
    agentSessionId: null,
    launchCommand: null,
    workingDirectory: null,
    paneLayout: null,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function buildTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 7,
    projectId: 1,
    unitId: null,
    serverName: null,
    title: 't',
    description: null,
    status: 'implementing',
    currentPhase: null,
    selfReviewCount: 0,
    priority: 0,
    tmuxWindow: null,
    selfReviewMaxAttempts: null,
    requirePlanApproval: false,
    source: 'local',
    sourceRef: null,
    inputTrust: 'trusted',
    executionApprovedFingerprintHash: null,
    pendingOperation: null,
    pendingOperationWindowId: null,
    pendingOperationPriorStatus: null,
    worktreePath: null,
    worktreeBranch: null,
    baseBranch: null,
    targetBranch: null,
    skipPr: false,
    workingDirectory: null,
    branch: null,
    planMarkdown: null,
    pendingQuestions: null,
    changedFiles: null,
    summaryJson: null,
    prUrl: null,
    agentSessionId: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  } as Task;
}

function buildDeps(opts: {
  findById?: ITaskRepository['findById'];
  listAllPanes?: TmuxClient['listAllPanes'];
  listSessions?: TmuxClient['listSessions'];
  getPanePid?: TmuxClient['getPanePid'];
  execCommand?: TmuxClient['execCommand'];
  servers?: ServerConfig[];
  claudeGetSessionCwd?: TranscriptSource['getSessionCwd'];
  claudeListSessions?: TranscriptSource['listSessions'];
  claudeGetSessionMtimeMs?: TranscriptSource['getSessionMtimeMs'];
  claudeGetSessionCreatedMs?: TranscriptSource['getSessionCreatedMs'];
  claudeGetSessionTailState?: TranscriptSource['getSessionTailState'];
  codexListSessions?: TranscriptSource['listSessions'];
  codexGetSessionMtimeMs?: TranscriptSource['getSessionMtimeMs'];
  codexGetSessionCreatedMs?: TranscriptSource['getSessionCreatedMs'];
} = {}) {
  const taskRepo = {
    findById: opts.findById ?? (() => null),
  } as unknown as ITaskRepository;

  const tmuxClient = {
    listAllPanes: opts.listAllPanes ?? (async () => []),
    listSessions: opts.listSessions ?? (async () => []),
    // getPanePid が未実装（デフォルトの undefined 呼び出し）のケースは、実際に tmuxClient に
    // メソッドが無いのと同じ状況を再現する — WindowSessionResolver.detectAgentProcess の
    // try/catch が例外を吸収し、レイヤー2「検出できず」として次のレイヤーへフォールバックする。
    getPanePid: opts.getPanePid,
    execCommand: opts.execCommand,
  } as unknown as TmuxClient;

  const serverRepo = {
    findByName: (name: string) => (opts.servers ?? [LOCAL_SERVER]).find((s) => s.name === name) ?? null,
  } as unknown as IServerRepository;

  const claudeSource = {
    agentType: 'claude',
    getSessionCwd: opts.claudeGetSessionCwd ?? (() => null),
    listSessions: opts.claudeListSessions ?? (() => []),
    getSessionMtimeMs: opts.claudeGetSessionMtimeMs ?? (() => null),
    getSessionCreatedMs: opts.claudeGetSessionCreatedMs ?? (() => null),
    // 既定は state:'unknown', lastEntryTimestampMs:null（getActivityStatus 側が従来通り mtime のみで
    // working 扱いにする — lastEntryTimestampMs が null のときは mtime にフォールバックする契約）。
    getSessionTailState: opts.claudeGetSessionTailState ?? (async () => ({ state: 'unknown' as const, lastEntryTimestampMs: null })),
  } as unknown as TranscriptSource;

  const codexSource = {
    agentType: 'codex',
    getSessionCwd: () => null,
    listSessions: opts.codexListSessions ?? (() => []),
    getSessionMtimeMs: opts.codexGetSessionMtimeMs ?? (() => null),
    getSessionCreatedMs: opts.codexGetSessionCreatedMs ?? (() => null),
    getSessionTailState: async () => ({ state: 'unknown' as const, lastEntryTimestampMs: null }),
  } as unknown as TranscriptSource;

  const sessionCaptureService = {
    adoptResolvedSession: vi.fn(() => false),
  } as unknown as SessionCaptureService;

  return { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService };
}

describe('WindowSessionResolver', () => {
  it('returns unsupported_server for a non-local server', async () => {
    const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService } = buildDeps({ servers: [AGENT_SERVER] });
    const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource], sessionCaptureService);
    const result = await resolver.resolve(buildWindow({ serverName: 'agent1' }));
    expect(result).toEqual({ resolved: false, reason: 'unsupported_server', agentDetected: false });
  });

  it('returns unsupported_server when the window\'s server is not found', async () => {
    const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService } = buildDeps({ servers: [] });
    const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource], sessionCaptureService);
    const result = await resolver.resolve(buildWindow());
    expect(result).toEqual({ resolved: false, reason: 'unsupported_server', agentDetected: false });
  });

  it('best-effort: a non-local server still gets a paneId/agentType/agentDetected hint when panes exist', async () => {
    const panes: TmuxPaneInfo[] = [
      { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'claude' },
    ];
    const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService } = buildDeps({
      servers: [AGENT_SERVER],
      listAllPanes: async () => panes,
    });
    const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource], sessionCaptureService);
    const result = await resolver.resolve(buildWindow({ serverName: 'agent1', workerType: 'claude' }));
    expect(result).toEqual({
      resolved: false,
      reason: 'unsupported_server',
      paneId: '%1',
      agentType: 'claude',
      agentDetected: true,
    });
  });

  it('priority 1: adopts the linked task\'s agent_session_id when the session file exists', async () => {
    const panes: TmuxPaneInfo[] = [
      { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'claude' },
    ];
    const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService } = buildDeps({
      findById: () => buildTask({ agentSessionId: SID_CLAUDE }),
      listAllPanes: async () => panes,
      claudeGetSessionCwd: (id) => (id === SID_CLAUDE ? { cwd: '/proj' } : null),
    });
    const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource], sessionCaptureService);
    const result = await resolver.resolve(buildWindow({ taskId: 7 }));
    expect(result).toEqual({ resolved: true, agentType: 'claude', sessionId: SID_CLAUDE, paneId: '%1', agentDetected: true });
  });

  it('falls back to cwd matching when the linked task has no session file', async () => {
    const panes: TmuxPaneInfo[] = [
      { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'claude' },
    ];
    const recentMtime = Date.now() - 5 * 60 * 1000;
    const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService } = buildDeps({
      findById: () => buildTask({ agentSessionId: 'not-a-real-session' }),
      listAllPanes: async () => panes,
      claudeGetSessionCwd: () => null, // session file does not exist
      claudeListSessions: () => [
        { sessionId: SID_CLAUDE, agentType: 'claude', projectDir: 'p', cwd: '/proj', mtimeMs: recentMtime, sizeBytes: 1, preview: '' },
      ],
    });
    const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource], sessionCaptureService);
    const result = await resolver.resolve(buildWindow({ taskId: 7 }));
    expect(result).toEqual({ resolved: true, agentType: 'claude', sessionId: SID_CLAUDE, paneId: '%1', agentDetected: true });
  });

  it('priority 2: matches across claude/codex sources and picks the most recently modified', async () => {
    const panes: TmuxPaneInfo[] = [
      { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'node' },
    ];
    const now = Date.now();
    const older: SessionSummary = { sessionId: SID_CLAUDE, agentType: 'claude', projectDir: 'p', cwd: '/proj', mtimeMs: now - 10 * 60 * 1000, sizeBytes: 1, preview: '' };
    const newer: SessionSummary = { sessionId: SID_CODEX, agentType: 'codex', projectDir: 'p', cwd: '/proj', mtimeMs: now - 2 * 60 * 1000, sizeBytes: 1, preview: '' };
    const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService } = buildDeps({
      listAllPanes: async () => panes,
      claudeListSessions: () => [older],
      codexListSessions: () => [newer],
    });
    const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource], sessionCaptureService);
    const result = await resolver.resolve(buildWindow());
    expect(result).toEqual({ resolved: true, agentType: 'codex', sessionId: SID_CODEX, paneId: '%1', agentDetected: false });
  });

  describe('write-back (Issue #338)', () => {
    it('tier3 (cwd fallback): writes the resolved session back onto the window via adoptResolvedSession', async () => {
      const panes: TmuxPaneInfo[] = [
        { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'node' },
      ];
      const recentMtime = Date.now() - 5 * 60 * 1000;
      const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService } = buildDeps({
        listAllPanes: async () => panes,
        claudeListSessions: () => [
          { sessionId: SID_CLAUDE, agentType: 'claude', projectDir: 'p', cwd: '/proj', mtimeMs: recentMtime, sizeBytes: 1, preview: '' },
        ],
      });
      const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource], sessionCaptureService);
      const window = buildWindow({ id: 99, taskId: null, agentSessionId: null });
      const result = await resolver.resolve(window);
      expect(result).toEqual({ resolved: true, agentType: 'claude', sessionId: SID_CLAUDE, paneId: '%1', agentDetected: false });
      expect(sessionCaptureService.adoptResolvedSession).toHaveBeenCalledTimes(1);
      expect(sessionCaptureService.adoptResolvedSession).toHaveBeenCalledWith(99, SID_CLAUDE);
    });

    it('tier1 (window-linked session): does not write back — the window already carries this session', async () => {
      const panes: TmuxPaneInfo[] = [
        { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'claude' },
      ];
      const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService } = buildDeps({
        listAllPanes: async () => panes,
        claudeGetSessionCwd: (id) => (id === SID_CLAUDE ? { cwd: '/proj' } : null),
      });
      const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource], sessionCaptureService);
      const result = await resolver.resolve(buildWindow({ taskId: null, agentSessionId: SID_CLAUDE, workerType: 'claude' }));
      expect(result).toEqual({ resolved: true, agentType: 'claude', sessionId: SID_CLAUDE, paneId: '%1', agentDetected: true });
      expect(sessionCaptureService.adoptResolvedSession).not.toHaveBeenCalled();
    });

    it('tier2 (task-linked session): does not write back — resolve() only calls adoptResolvedSession for tier3', async () => {
      const panes: TmuxPaneInfo[] = [
        { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'claude' },
      ];
      const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService } = buildDeps({
        findById: () => buildTask({ agentSessionId: SID_CLAUDE }),
        listAllPanes: async () => panes,
        claudeGetSessionCwd: (id) => (id === SID_CLAUDE ? { cwd: '/proj' } : null),
      });
      const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource], sessionCaptureService);
      const result = await resolver.resolve(buildWindow({ taskId: 7, agentSessionId: null }));
      expect(result).toEqual({ resolved: true, agentType: 'claude', sessionId: SID_CLAUDE, paneId: '%1', agentDetected: true });
      expect(sessionCaptureService.adoptResolvedSession).not.toHaveBeenCalled();
    });
  });

  it('returns no_recent_session when the only cwd-matching session is older than 30 minutes, with a best-effort pane hint', async () => {
    const panes: TmuxPaneInfo[] = [
      { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'node' },
    ];
    const staleMtime = Date.now() - 31 * 60 * 1000;
    const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService } = buildDeps({
      listAllPanes: async () => panes,
      claudeListSessions: () => [
        { sessionId: SID_CLAUDE, agentType: 'claude', projectDir: 'p', cwd: '/proj', mtimeMs: staleMtime, sizeBytes: 1, preview: '' },
      ],
    });
    const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource], sessionCaptureService);
    const result = await resolver.resolve(buildWindow());
    // window.workerType defaults to 'claude'; the single 'node' pane still matches the node-ish fallback
    // in selectPane, so a best-effort paneId is returned even though no session could be resolved.
    expect(result).toEqual({ resolved: false, reason: 'no_recent_session', paneId: '%1', agentType: 'claude', agentDetected: false });
  });

  it('returns no_recent_session when no session cwd matches any pane, with a best-effort pane hint', async () => {
    const panes: TmuxPaneInfo[] = [
      { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'node' },
    ];
    const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService } = buildDeps({
      listAllPanes: async () => panes,
      claudeListSessions: () => [
        { sessionId: SID_CLAUDE, agentType: 'claude', projectDir: 'p', cwd: '/other', mtimeMs: Date.now(), sizeBytes: 1, preview: '' },
      ],
    });
    const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource], sessionCaptureService);
    const result = await resolver.resolve(buildWindow());
    expect(result).toEqual({ resolved: false, reason: 'no_recent_session', paneId: '%1', agentType: 'claude', agentDetected: false });
  });

  it('returns no_recent_session with no pane hint when the window has no panes at all', async () => {
    const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService } = buildDeps({ listAllPanes: async () => [] });
    const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource], sessionCaptureService);
    const result = await resolver.resolve(buildWindow());
    expect(result).toEqual({ resolved: false, reason: 'no_recent_session', agentDetected: false });
  });

  it('best-effort: paneLayout meta still picks the pane, but agentDetected is false when the live command is not claude/codex (Important #3)', async () => {
    // The pane's currentCommand is 'bash' — the agent that used to run here has died and dropped back
    // to a shell. A stale paneLayout meta match must not report agentDetected:true in that case (it
    // would hide the "agent not running" warning from the user).
    const panes: TmuxPaneInfo[] = [
      { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'bash' },
    ];
    const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService } = buildDeps({ listAllPanes: async () => panes });
    const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource], sessionCaptureService);
    const result = await resolver.resolve(
      buildWindow({
        workerType: 'claude',
        paneLayout: { layout: 'even-horizontal', panes: [{ index: 0, command: null, workingDirectory: null, title: null, workerType: 'claude' }] },
      }),
    );
    expect(result).toEqual({ resolved: false, reason: 'no_recent_session', paneId: '%1', agentType: 'claude', agentDetected: false });
  });

  it('priority 3: prefers a pane whose current command looks like an agent over the active pane', async () => {
    const panes: TmuxPaneInfo[] = [
      { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'bash' },
      { paneId: '%2', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 1, currentPath: '/proj', currentCommand: 'claude' },
    ];
    const recentMtime = Date.now() - 1000;
    const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService } = buildDeps({
      listAllPanes: async () => panes,
      claudeListSessions: () => [
        { sessionId: SID_CLAUDE, agentType: 'claude', projectDir: 'p', cwd: '/proj', mtimeMs: recentMtime, sizeBytes: 1, preview: '' },
      ],
    });
    const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource], sessionCaptureService);
    const result = await resolver.resolve(buildWindow());
    expect(result).toEqual({ resolved: true, agentType: 'claude', sessionId: SID_CLAUDE, paneId: '%2', agentDetected: true });
  });

  it('priority 3: falls back to the active pane when no pane command looks like an agent', async () => {
    const panes: TmuxPaneInfo[] = [
      { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'bash' },
      { paneId: '%2', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 1, currentPath: '/proj', currentCommand: 'vim' },
    ];
    const recentMtime = Date.now() - 1000;
    const sessions: TmuxSession[] = [
      {
        name: 'main',
        windowCount: 1,
        attached: true,
        created: 0,
        windows: [
          {
            index: 0,
            name: 'w0',
            active: true,
            activity: 0,
            panes: [
              { index: 0, command: 'bash', title: '', width: 80, height: 24, active: false, pid: 1 },
              { index: 1, command: 'vim', title: '', width: 80, height: 24, active: true, pid: 2 },
            ],
          },
        ],
      },
    ];
    const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService } = buildDeps({
      listAllPanes: async () => panes,
      listSessions: async () => sessions,
      claudeListSessions: () => [
        { sessionId: SID_CLAUDE, agentType: 'claude', projectDir: 'p', cwd: '/proj', mtimeMs: recentMtime, sizeBytes: 1, preview: '' },
      ],
    });
    const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource], sessionCaptureService);
    const result = await resolver.resolve(buildWindow());
    expect(result).toEqual({ resolved: true, agentType: 'claude', sessionId: SID_CLAUDE, paneId: '%2', agentDetected: false });
  });

  it('priority 1: resolves a project-owned window (no taskId) via its own agent_session_id', async () => {
    const findById = () => { throw new Error('should not be called'); };
    const panes: TmuxPaneInfo[] = [
      { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'claude' },
    ];
    const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService } = buildDeps({
      findById,
      listAllPanes: async () => panes,
      claudeGetSessionCwd: (id) => (id === SID_CLAUDE ? { cwd: '/proj' } : null),
    });
    const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource], sessionCaptureService);
    const result = await resolver.resolve(buildWindow({ taskId: null, agentSessionId: SID_CLAUDE, workerType: 'claude' }));
    expect(result).toEqual({ resolved: true, agentType: 'claude', sessionId: SID_CLAUDE, paneId: '%1', agentDetected: true });
  });

  it('priority 1: resolves a window\'s own session via the codex source when workerType is codex', async () => {
    const panes: TmuxPaneInfo[] = [
      { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'codex' },
    ];
    const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService } = buildDeps({
      listAllPanes: async () => panes,
    });
    const codexWithSession = {
      ...codexSource,
      getSessionCwd: (id: string) => (id === SID_CODEX ? { cwd: '/proj' } : null),
    } as unknown as TranscriptSource;
    const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexWithSession], sessionCaptureService);
    const result = await resolver.resolve(buildWindow({ taskId: null, agentSessionId: SID_CODEX, workerType: 'codex' }));
    expect(result).toEqual({ resolved: true, agentType: 'codex', sessionId: SID_CODEX, paneId: '%1', agentDetected: true });
  });

  it('priority 1: falls back to trying all sources when the window workerType is unsupported (e.g. generic)', async () => {
    const panes: TmuxPaneInfo[] = [
      { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'codex' },
    ];
    const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService } = buildDeps({
      listAllPanes: async () => panes,
    });
    const codexWithSession = {
      ...codexSource,
      getSessionCwd: (id: string) => (id === SID_CODEX ? { cwd: '/proj' } : null),
    } as unknown as TranscriptSource;
    const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexWithSession], sessionCaptureService);
    const result = await resolver.resolve(buildWindow({ taskId: null, agentSessionId: SID_CODEX, workerType: 'generic' }));
    expect(result).toEqual({ resolved: true, agentType: 'codex', sessionId: SID_CODEX, paneId: '%1', agentDetected: true });
  });

  it('priority 2: falls back to trying all sources for the task session when window workerType is unknown', async () => {
    const panes: TmuxPaneInfo[] = [
      { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'codex' },
    ];
    const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService } = buildDeps({
      findById: () => buildTask({ agentSessionId: SID_CODEX }),
      listAllPanes: async () => panes,
    });
    const codexWithSession = {
      ...codexSource,
      getSessionCwd: (id: string) => (id === SID_CODEX ? { cwd: '/proj' } : null),
    } as unknown as TranscriptSource;
    const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexWithSession], sessionCaptureService);
    const result = await resolver.resolve(buildWindow({ taskId: 7, workerType: null }));
    expect(result).toEqual({ resolved: true, agentType: 'codex', sessionId: SID_CODEX, paneId: '%1', agentDetected: true });
  });

  it('pane selection: prefers a claude pane over an earlier node pane (exact command match)', async () => {
    const panes: TmuxPaneInfo[] = [
      { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'node' },
      { paneId: '%2', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 1, currentPath: '/proj', currentCommand: 'claude' },
    ];
    const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService } = buildDeps({
      findById: () => buildTask({ agentSessionId: SID_CLAUDE }),
      listAllPanes: async () => panes,
      claudeGetSessionCwd: (id) => (id === SID_CLAUDE ? { cwd: '/proj' } : null),
    });
    const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource], sessionCaptureService);
    const result = await resolver.resolve(buildWindow({ taskId: 7 }));
    expect(result).toEqual({ resolved: true, agentType: 'claude', sessionId: SID_CLAUDE, paneId: '%2', agentDetected: true });
  });

  it('pane selection: paneLayout meta (agentSessionId) wins over an unrelated exact-command pane, but agentDetected reflects the live command (Important #3)', async () => {
    const panes: TmuxPaneInfo[] = [
      { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'claude' },
      { paneId: '%2', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 1, currentPath: '/proj', currentCommand: 'bash' },
    ];
    const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService } = buildDeps({
      findById: () => buildTask({ agentSessionId: SID_CLAUDE }),
      listAllPanes: async () => panes,
      claudeGetSessionCwd: (id) => (id === SID_CLAUDE ? { cwd: '/proj' } : null),
    });
    const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource], sessionCaptureService);
    const result = await resolver.resolve(
      buildWindow({
        taskId: 7,
        paneLayout: {
          layout: 'even-horizontal',
          panes: [
            { index: 0, command: null, workingDirectory: null, title: null },
            { index: 1, command: null, workingDirectory: null, title: null, agentSessionId: SID_CLAUDE },
          ],
        },
      }),
    );
    // Pane selection still honors the meta match (paneId '%2'), but that pane's live command is 'bash'
    // (the agent died), so agentDetected must be false rather than trusting the stale meta.
    expect(result).toEqual({ resolved: true, agentType: 'claude', sessionId: SID_CLAUDE, paneId: '%2', agentDetected: false });
  });

  it('does not consult the task at all when the window has no taskId', async () => {
    const findById = () => { throw new Error('should not be called'); };
    const panes: TmuxPaneInfo[] = [
      { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'claude' },
    ];
    const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService } = buildDeps({
      findById,
      listAllPanes: async () => panes,
      claudeListSessions: () => [
        { sessionId: SID_CLAUDE, agentType: 'claude', projectDir: 'p', cwd: '/proj', mtimeMs: Date.now(), sizeBytes: 1, preview: '' },
      ],
    });
    const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource], sessionCaptureService);
    const result = await resolver.resolve(buildWindow({ taskId: null }));
    expect(result).toEqual({ resolved: true, agentType: 'claude', sessionId: SID_CLAUDE, paneId: '%1', agentDetected: true });
  });

  describe('agentDetected multi-layer detection (real Claude Code panes report pane_current_command="node")', () => {
    const PS_OUTPUT_WITH_CLAUDE_DESCENDANT = [
      '  9000      1     90 node /path/to/azito-supervisor.cjs -- claude --dangerously-skip-permissions',
      '  9001   9000     42 claude --dangerously-skip-permissions --model claude-opus-4-6[1m]',
    ].join('\n');
    const PS_OUTPUT_NO_AGENT = ['  9000      1     90 node /path/to/some-other-script.js'].join('\n');

    it('layer 2: detects the agent via process inspection when pane_current_command is "node" (local server)', async () => {
      const panes: TmuxPaneInfo[] = [
        { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'node' },
      ];
      const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService } = buildDeps({
        listAllPanes: async () => panes,
        getPanePid: async () => 9000,
        execCommand: async () => ({ stdout: PS_OUTPUT_WITH_CLAUDE_DESCENDANT, stderr: '', code: 0 }),
      });
      const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource], sessionCaptureService);
      const result = await resolver.resolve(buildWindow());
      expect(result).toEqual({ resolved: false, reason: 'no_recent_session', paneId: '%1', agentType: 'claude', agentDetected: true });
    });

    it('layer 2 is skipped on non-local servers (agent/ssh) even when pane_current_command is "node"', async () => {
      const panes: TmuxPaneInfo[] = [
        { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'node' },
      ];
      const getPanePid = vi.fn(async () => 9000);
      const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService } = buildDeps({
        servers: [AGENT_SERVER],
        listAllPanes: async () => panes,
        getPanePid,
        execCommand: async () => ({ stdout: PS_OUTPUT_WITH_CLAUDE_DESCENDANT, stderr: '', code: 0 }),
      });
      const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource], sessionCaptureService);
      const result = await resolver.resolve(buildWindow({ serverName: 'agent1', workerType: 'claude' }));
      expect(getPanePid).not.toHaveBeenCalled();
      expect(result).toEqual({ resolved: false, reason: 'unsupported_server', paneId: '%1', agentType: 'claude', agentDetected: false });
    });

    it('layer 3: falls back to the session activity signal when process inspection finds nothing', async () => {
      const panes: TmuxPaneInfo[] = [
        { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'node' },
      ];
      const recentMtime = Date.now() - 5 * 1000; // 5s ago, well within the 120s activity window
      const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService } = buildDeps({
        findById: () => buildTask({ agentSessionId: SID_CLAUDE }),
        listAllPanes: async () => panes,
        claudeGetSessionCwd: (id) => (id === SID_CLAUDE ? { cwd: '/proj' } : null),
        claudeGetSessionMtimeMs: (id) => (id === SID_CLAUDE ? recentMtime : null),
        getPanePid: async () => 9000,
        execCommand: async () => ({ stdout: PS_OUTPUT_NO_AGENT, stderr: '', code: 0 }),
      });
      const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource], sessionCaptureService);
      const result = await resolver.resolve(buildWindow({ taskId: 7 }));
      expect(result).toEqual({ resolved: true, agentType: 'claude', sessionId: SID_CLAUDE, paneId: '%1', agentDetected: true });
    });

    it('layer 3 does not trigger when the session mtime is outside the 120s activity window', async () => {
      const panes: TmuxPaneInfo[] = [
        { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'node' },
      ];
      const staleMtime = Date.now() - 121 * 1000;
      const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService } = buildDeps({
        findById: () => buildTask({ agentSessionId: SID_CLAUDE }),
        listAllPanes: async () => panes,
        claudeGetSessionCwd: (id) => (id === SID_CLAUDE ? { cwd: '/proj' } : null),
        claudeGetSessionMtimeMs: (id) => (id === SID_CLAUDE ? staleMtime : null),
        getPanePid: async () => 9000,
        execCommand: async () => ({ stdout: PS_OUTPUT_NO_AGENT, stderr: '', code: 0 }),
      });
      const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource], sessionCaptureService);
      const result = await resolver.resolve(buildWindow({ taskId: 7 }));
      expect(result).toEqual({ resolved: true, agentType: 'claude', sessionId: SID_CLAUDE, paneId: '%1', agentDetected: false });
    });

    it('all layers false: a plain bash pane with no matching process or recent session reports agentDetected:false', async () => {
      const panes: TmuxPaneInfo[] = [
        { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'bash' },
      ];
      const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService } = buildDeps({
        listAllPanes: async () => panes,
        getPanePid: async () => 9000,
        execCommand: async () => ({ stdout: PS_OUTPUT_NO_AGENT, stderr: '', code: 0 }),
      });
      const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource], sessionCaptureService);
      const result = await resolver.resolve(buildWindow());
      expect(result).toEqual({ resolved: false, reason: 'no_recent_session', paneId: '%1', agentType: 'claude', agentDetected: false });
    });

    it('layer 2 failure (tmux/ps error) falls through to layer 3 instead of throwing', async () => {
      const panes: TmuxPaneInfo[] = [
        { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'node' },
      ];
      const recentMtime = Date.now() - 5 * 1000;
      const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService } = buildDeps({
        findById: () => buildTask({ agentSessionId: SID_CLAUDE }),
        listAllPanes: async () => panes,
        claudeGetSessionCwd: (id) => (id === SID_CLAUDE ? { cwd: '/proj' } : null),
        claudeGetSessionMtimeMs: (id) => (id === SID_CLAUDE ? recentMtime : null),
        getPanePid: async () => { throw new Error('tmux display-message failed'); },
      });
      const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource], sessionCaptureService);
      const result = await resolver.resolve(buildWindow({ taskId: 7 }));
      expect(result).toEqual({ resolved: true, agentType: 'claude', sessionId: SID_CLAUDE, paneId: '%1', agentDetected: true });
    });
  });

  describe('process start-time gate (Issue #338): prevents a stale session from a previous claude/codex in the same cwd from being shown', () => {
    // A currently-running agent process launched ~10s ago (root pid 9000, node shebang wrapper,
    // claude descendant at pid 9001, etimes=10).
    const PS_OUTPUT_RECENT_AGENT = [
      '  9000      1     50 node /path/to/azito-supervisor.cjs -- claude --dangerously-skip-permissions',
      '  9001   9000     10 claude --dangerously-skip-permissions --model claude-opus-4-6[1m]',
    ].join('\n');
    const PS_OUTPUT_NO_AGENT = ['  9000      1     50 node /path/to/some-other-script.js'].join('\n');

    it('tier1: rejects window.agentSessionId when its mtime predates the current agent process start by more than the 180s explicit-link skew, falling back to unresolved', async () => {
      const panes: TmuxPaneInfo[] = [
        { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'node' },
      ];
      const staleMtime = Date.now() - 10 * 60 * 1000; // 10min ago: older than (processStart(-10s) - 180s skew) = -190s
      const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService } = buildDeps({
        listAllPanes: async () => panes,
        claudeGetSessionCwd: (id) => (id === SID_CLAUDE ? { cwd: '/proj' } : null),
        claudeGetSessionMtimeMs: (id) => (id === SID_CLAUDE ? staleMtime : null),
        getPanePid: async () => 9000,
        execCommand: async () => ({ stdout: PS_OUTPUT_RECENT_AGENT, stderr: '', code: 0 }),
      });
      const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource], sessionCaptureService);
      const result = await resolver.resolve(buildWindow({ taskId: null, agentSessionId: SID_CLAUDE, workerType: 'claude' }));
      // The stale session is rejected by the gate; no other candidate exists, so it falls through to
      // the best-effort unresolved pane hint (the live process is still detected as agentDetected:true).
      expect(result).toEqual({ resolved: false, reason: 'no_recent_session', paneId: '%1', agentType: 'claude', agentDetected: true });
    });

    it('tier1: accepts window.agentSessionId when its mtime is stale by 60s but still within the 180s explicit-link skew (Issue #338 follow-up: supervisor-launched resume/pre-created sessions can lag the process start by tens of seconds)', async () => {
      const panes: TmuxPaneInfo[] = [
        { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'node' },
      ];
      const staleMtime = Date.now() - 60 * 1000; // 60s ago: within (processStart(-10s) - 180s skew) = -190s
      const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService } = buildDeps({
        listAllPanes: async () => panes,
        claudeGetSessionCwd: (id) => (id === SID_CLAUDE ? { cwd: '/proj' } : null),
        claudeGetSessionMtimeMs: (id) => (id === SID_CLAUDE ? staleMtime : null),
        getPanePid: async () => 9000,
        execCommand: async () => ({ stdout: PS_OUTPUT_RECENT_AGENT, stderr: '', code: 0 }),
      });
      const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource], sessionCaptureService);
      const result = await resolver.resolve(buildWindow({ taskId: null, agentSessionId: SID_CLAUDE, workerType: 'claude' }));
      expect(result).toEqual({ resolved: true, agentType: 'claude', sessionId: SID_CLAUDE, paneId: '%1', agentDetected: true });
    });

    it('tier3 (cwd fallback) still rejects a session stale by 60s — the 15s skew is unchanged for the cwd-guess tier, unlike the explicit-link tiers', async () => {
      const panes: TmuxPaneInfo[] = [
        { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'node' },
      ];
      const staleMtime = Date.now() - 60 * 1000; // 60s ago: older than (processStart(-10s) - 15s skew) = -25s
      const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService } = buildDeps({
        listAllPanes: async () => panes,
        claudeListSessions: () => [
          { sessionId: SID_CLAUDE, agentType: 'claude', projectDir: 'p', cwd: '/proj', mtimeMs: staleMtime, sizeBytes: 1, preview: '' },
        ],
        getPanePid: async () => 9000,
        execCommand: async () => ({ stdout: PS_OUTPUT_RECENT_AGENT, stderr: '', code: 0 }),
      });
      const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource], sessionCaptureService);
      // No window/task link at all, so this exercises tier3 (cwd match) only.
      const result = await resolver.resolve(buildWindow({ taskId: null, agentSessionId: null, workerType: null }));
      expect(result).toEqual({ resolved: false, reason: 'no_recent_session', paneId: '%1', agentType: 'claude', agentDetected: true });
    });

    it('tier3 (cwd fallback) adopts a session whose mtime is very stale but whose creation time is within 5 minutes of the process start (Issue #338 follow-up: an idle existing conversation is legitimately this process\'s own session even if it stopped writing long ago)', async () => {
      const panes: TmuxPaneInfo[] = [
        { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'node' },
      ];
      const staleMtime = Date.now() - 2 * 60 * 60 * 1000; // 2 hours ago: far outside RECENT_SESSION_WINDOW_MS (30min)
      const createdNearProcessStart = Date.now() - 10 * 1000; // matches the mocked process start (~10s ago)
      const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService } = buildDeps({
        listAllPanes: async () => panes,
        claudeListSessions: () => [
          { sessionId: SID_CLAUDE, agentType: 'claude', projectDir: 'p', cwd: '/proj', mtimeMs: staleMtime, sizeBytes: 1, preview: '' },
        ],
        claudeGetSessionCreatedMs: (id) => (id === SID_CLAUDE ? createdNearProcessStart : null),
        getPanePid: async () => 9000,
        execCommand: async () => ({ stdout: PS_OUTPUT_RECENT_AGENT, stderr: '', code: 0 }),
      });
      const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource], sessionCaptureService);
      const result = await resolver.resolve(buildWindow({ taskId: null, agentSessionId: null, workerType: null }));
      expect(result).toEqual({ resolved: true, agentType: 'claude', sessionId: SID_CLAUDE, paneId: '%1', agentDetected: true });
    });

    it('tier3 (cwd fallback) does not bypass the mtime gate when the session creation time is outside the 5-minute skew (stale-mtime rejection still applies)', async () => {
      const panes: TmuxPaneInfo[] = [
        { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'node' },
      ];
      const staleMtime = Date.now() - 60 * 1000; // 60s ago: older than (processStart(-10s) - 15s skew) = -25s
      const createdLongBefore = Date.now() - 60 * 60 * 1000; // 1 hour before process start: outside the 5-minute skew
      const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService } = buildDeps({
        listAllPanes: async () => panes,
        claudeListSessions: () => [
          { sessionId: SID_CLAUDE, agentType: 'claude', projectDir: 'p', cwd: '/proj', mtimeMs: staleMtime, sizeBytes: 1, preview: '' },
        ],
        claudeGetSessionCreatedMs: (id) => (id === SID_CLAUDE ? createdLongBefore : null),
        getPanePid: async () => 9000,
        execCommand: async () => ({ stdout: PS_OUTPUT_RECENT_AGENT, stderr: '', code: 0 }),
      });
      const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource], sessionCaptureService);
      const result = await resolver.resolve(buildWindow({ taskId: null, agentSessionId: null, workerType: null }));
      expect(result).toEqual({ resolved: false, reason: 'no_recent_session', paneId: '%1', agentType: 'claude', agentDetected: true });
    });

    it('tier1: accepts window.agentSessionId regardless of mtime when a descendant process\'s args contain the session id (deterministic evidence bypasses the mtime gate entirely, Issue #338 follow-up: the reported bug — session file mtime precedes the process start by seconds because the supervisor writes the file before launching the process)', async () => {
      const panes: TmuxPaneInfo[] = [
        { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'node' },
      ];
      const PS_OUTPUT_WITH_RESUME_ARG = [
        '  9000      1     50 node /path/to/azito-supervisor.cjs -- codex resume ' + SID_CODEX,
        '  9001   9000     10 /opt/codex/bin/codex resume ' + SID_CODEX,
      ].join('\n');
      const staleMtime = Date.now() - 18 * 1000; // mtime precedes processStart(-10s) by 18s: would be rejected by any mtime-based skew this small, but args evidence bypasses it entirely
      const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService } = buildDeps({
        listAllPanes: async () => panes,
        getPanePid: async () => 9000,
        execCommand: async () => ({ stdout: PS_OUTPUT_WITH_RESUME_ARG, stderr: '', code: 0 }),
      });
      const codexWithSession = {
        ...codexSource,
        getSessionCwd: (id: string) => (id === SID_CODEX ? { cwd: '/proj' } : null),
        getSessionMtimeMs: (id: string) => (id === SID_CODEX ? staleMtime : null),
      } as unknown as TranscriptSource;
      const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexWithSession], sessionCaptureService);
      const result = await resolver.resolve(buildWindow({ taskId: null, agentSessionId: SID_CODEX, workerType: 'codex' }));
      expect(result).toEqual({ resolved: true, agentType: 'codex', sessionId: SID_CODEX, paneId: '%1', agentDetected: true });
    });

    it('tier1: accepts window.agentSessionId when its mtime has been updated at/after the process start (resume case)', async () => {
      const panes: TmuxPaneInfo[] = [
        { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'node' },
      ];
      const recentMtime = Date.now() - 5 * 1000; // 5s ago: within (processStart(-10s) - 15s skew) = -25s
      const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService } = buildDeps({
        listAllPanes: async () => panes,
        claudeGetSessionCwd: (id) => (id === SID_CLAUDE ? { cwd: '/proj' } : null),
        claudeGetSessionMtimeMs: (id) => (id === SID_CLAUDE ? recentMtime : null),
        getPanePid: async () => 9000,
        execCommand: async () => ({ stdout: PS_OUTPUT_RECENT_AGENT, stderr: '', code: 0 }),
      });
      const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource], sessionCaptureService);
      const result = await resolver.resolve(buildWindow({ taskId: null, agentSessionId: SID_CLAUDE, workerType: 'claude' }));
      expect(result).toEqual({ resolved: true, agentType: 'claude', sessionId: SID_CLAUDE, paneId: '%1', agentDetected: true });
    });

    it('gate unavailable (ps call fails): keeps the old existence-only behavior, accepting a session regardless of mtime', async () => {
      const panes: TmuxPaneInfo[] = [
        { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'claude' },
      ];
      const veryStaleMtime = Date.now() - 60 * 60 * 1000; // 1 hour ago
      const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService } = buildDeps({
        listAllPanes: async () => panes,
        claudeGetSessionCwd: (id) => (id === SID_CLAUDE ? { cwd: '/proj' } : null),
        claudeGetSessionMtimeMs: (id) => (id === SID_CLAUDE ? veryStaleMtime : null),
        // execCommand is intentionally not mocked (undefined), simulating a tmux/ps failure.
      });
      const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource], sessionCaptureService);
      const result = await resolver.resolve(buildWindow({ taskId: null, agentSessionId: SID_CLAUDE, workerType: 'claude' }));
      expect(result).toEqual({ resolved: true, agentType: 'claude', sessionId: SID_CLAUDE, paneId: '%1', agentDetected: true });
    });

    it('tier3 (cwd fallback) is disabled entirely when the agent process is not detected in this window (bash pane)', async () => {
      const panes: TmuxPaneInfo[] = [
        { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'bash' },
      ];
      const recentMtime = Date.now() - 5 * 1000; // would pass the old 30-minute cwd-match rule
      const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService } = buildDeps({
        listAllPanes: async () => panes,
        claudeListSessions: () => [
          { sessionId: SID_CLAUDE, agentType: 'claude', projectDir: 'p', cwd: '/proj', mtimeMs: recentMtime, sizeBytes: 1, preview: '' },
        ],
        getPanePid: async () => 9000,
        execCommand: async () => ({ stdout: PS_OUTPUT_NO_AGENT, stderr: '', code: 0 }),
      });
      const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource], sessionCaptureService);
      const result = await resolver.resolve(buildWindow({ workerType: 'claude' }));
      // Without the process-detection gate, this would have matched the recent cwd session
      // (reproducing the reported bug: a bash pane in the same cwd showing an unrelated old chat).
      // With gate.kind === 'not_detected', tier3 is skipped entirely, leaving it unresolved.
      expect(result).toEqual({ resolved: false, reason: 'no_recent_session', paneId: '%1', agentType: 'claude', agentDetected: false });
    });
  });

  describe('tier3 cross-agent-type mismatch (Issue #338 follow-up: codex pane mislabeled as claude)', () => {
    // A codex process detected in this window's pane (root pid 9000, node shebang wrapper +
    // native codex descendant, etimes=10 -> started ~10s ago).
    const PS_OUTPUT_CODEX_AGENT = [
      '  9000      1     50 node /path/to/some-shell',
      '  9001   9000     10 node /opt/nodenv/versions/24.14.0/bin/codex',
      '  9002   9001      9 /opt/nodenv/versions/24.14.0/lib/node_modules/@openai/codex/vendor/x86_64/bin/codex',
    ].join('\n');

    it('does not pick a more-recently-modified claude session at the same cwd when this window is actually running codex', async () => {
      const panes: TmuxPaneInfo[] = [
        { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'node' },
      ];
      const now = Date.now();
      // The claude session (e.g. actively streaming in a *different* window sharing the same cwd)
      // has a more recent mtime than the codex session actually running in *this* window/pane.
      const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService } = buildDeps({
        listAllPanes: async () => panes,
        claudeListSessions: () => [
          { sessionId: SID_CLAUDE, agentType: 'claude', projectDir: 'p', cwd: '/proj', mtimeMs: now - 2_000, sizeBytes: 1, preview: '' },
        ],
        claudeGetSessionMtimeMs: (id) => (id === SID_CLAUDE ? now - 2_000 : null),
        codexListSessions: () => [
          { sessionId: SID_CODEX, agentType: 'codex', projectDir: 'p', cwd: '/proj', mtimeMs: now - 20_000, sizeBytes: 1, preview: '' },
        ],
        codexGetSessionMtimeMs: (id) => (id === SID_CODEX ? now - 20_000 : null),
        getPanePid: async () => 9000,
        execCommand: async () => ({ stdout: PS_OUTPUT_CODEX_AGENT, stderr: '', code: 0 }),
      });
      const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource], sessionCaptureService);
      const result = await resolver.resolve(buildWindow({ taskId: null, agentSessionId: null, workerType: null }));
      expect(result).toEqual({ resolved: true, agentType: 'codex', sessionId: SID_CODEX, paneId: '%1', agentDetected: true });
    });

    it('best-effort unresolved fallback: uses the process-detected agent type when workerType is unset', async () => {
      const panes: TmuxPaneInfo[] = [
        { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'node' },
      ];
      const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService } = buildDeps({
        listAllPanes: async () => panes,
        getPanePid: async () => 9000,
        execCommand: async () => ({ stdout: PS_OUTPUT_CODEX_AGENT, stderr: '', code: 0 }),
      });
      const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource], sessionCaptureService);
      const result = await resolver.resolve(buildWindow({ taskId: null, agentSessionId: null, workerType: null }));
      // No session file at all (no *ListSessions mocked), so this falls through to the best-effort
      // unresolved path. Even though window.workerType is null, agentType should still be 'codex'
      // because it's the only type process detection actually found running in this window.
      expect(result).toEqual({ resolved: false, reason: 'no_recent_session', paneId: '%1', agentType: 'codex', agentDetected: true });
    });

    it('window.workerType still takes priority over process detection for the best-effort fallback agentType', async () => {
      const panes: TmuxPaneInfo[] = [
        { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'node' },
      ];
      const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService } = buildDeps({
        listAllPanes: async () => panes,
        getPanePid: async () => 9000,
        execCommand: async () => ({ stdout: PS_OUTPUT_CODEX_AGENT, stderr: '', code: 0 }),
      });
      const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource], sessionCaptureService);
      // workerType explicitly set to 'claude' even though the live process detected is codex
      // (e.g. stale window metadata) — the explicit workerType still wins.
      const result = await resolver.resolve(buildWindow({ taskId: null, agentSessionId: null, workerType: 'claude' }));
      expect(result).toEqual({ resolved: false, reason: 'no_recent_session', paneId: '%1', agentType: 'claude', agentDetected: true });
    });
  });

  describe('getActivityStatus (Issue #338 フォロー: process-based working/idle/offline classification)', () => {
    const PS_OUTPUT_WITH_CLAUDE_DESCENDANT = [
      '  9000      1     90 node /path/to/azito-supervisor.cjs -- claude --dangerously-skip-permissions',
      '  9001   9000     42 claude --dangerously-skip-permissions --model claude-opus-4-6[1m]',
    ].join('\n');
    const PS_OUTPUT_NO_AGENT = ['  9000      1     90 node /path/to/some-other-script.js'].join('\n');

    it('returns offline when the server is not local', async () => {
      const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService } = buildDeps({ servers: [AGENT_SERVER] });
      const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource], sessionCaptureService);
      const result = await resolver.getActivityStatus(buildWindow({ serverName: 'agent1' }));
      expect(result.status).toBe('offline');
    });

    it('returns offline when no agent process is found in any pane', async () => {
      const panes: TmuxPaneInfo[] = [
        { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'bash' },
      ];
      const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService } = buildDeps({
        listAllPanes: async () => panes,
        getPanePid: async () => 9000,
        execCommand: async () => ({ stdout: PS_OUTPUT_NO_AGENT, stderr: '', code: 0 }),
      });
      const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource], sessionCaptureService);
      const result = await resolver.getActivityStatus(buildWindow());
      expect(result.status).toBe('offline');
    });

    it('returns idle when a process is alive but the window has no linked session', async () => {
      const panes: TmuxPaneInfo[] = [
        { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'node' },
      ];
      const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService } = buildDeps({
        listAllPanes: async () => panes,
        getPanePid: async () => 9000,
        execCommand: async () => ({ stdout: PS_OUTPUT_WITH_CLAUDE_DESCENDANT, stderr: '', code: 0 }),
      });
      const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource], sessionCaptureService);
      const result = await resolver.getActivityStatus(buildWindow({ agentSessionId: null, taskId: null }));
      expect(result.status).toBe('idle');
    });

    it('returns idle when the linked session mtime is stale (>120s)', async () => {
      const panes: TmuxPaneInfo[] = [
        { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'node' },
      ];
      const staleMtime = Date.now() - 121 * 1000;
      const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService } = buildDeps({
        listAllPanes: async () => panes,
        getPanePid: async () => 9000,
        execCommand: async () => ({ stdout: PS_OUTPUT_WITH_CLAUDE_DESCENDANT, stderr: '', code: 0 }),
        claudeGetSessionMtimeMs: (id) => (id === SID_CLAUDE ? staleMtime : null),
      });
      const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource], sessionCaptureService);
      const result = await resolver.getActivityStatus(buildWindow({ agentSessionId: SID_CLAUDE, workerType: 'claude' }));
      expect(result.status).toBe('idle');
    });

    it('returns working when a process is alive and its linked session was written within 120s', async () => {
      const panes: TmuxPaneInfo[] = [
        { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'node' },
      ];
      const recentMtime = Date.now() - 5 * 1000;
      const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService } = buildDeps({
        listAllPanes: async () => panes,
        getPanePid: async () => 9000,
        execCommand: async () => ({ stdout: PS_OUTPUT_WITH_CLAUDE_DESCENDANT, stderr: '', code: 0 }),
        claudeGetSessionMtimeMs: (id) => (id === SID_CLAUDE ? recentMtime : null),
        claudeGetSessionTailState: async () => ({ state: 'in_progress' as const, lastEntryTimestampMs: recentMtime }),
      });
      const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource], sessionCaptureService);
      const result = await resolver.getActivityStatus(buildWindow({ agentSessionId: SID_CLAUDE, workerType: 'claude' }));
      expect(result).toEqual({ status: 'working', completedAt: null, interruptedAt: null });
    });

    it('returns idle when mtime is recent but the tail record is terminal_interrupted (stop-button interrupt)', async () => {
      const panes: TmuxPaneInfo[] = [
        { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'node' },
      ];
      const recentMtime = Date.now() - 5 * 1000;
      const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService } = buildDeps({
        listAllPanes: async () => panes,
        getPanePid: async () => 9000,
        execCommand: async () => ({ stdout: PS_OUTPUT_WITH_CLAUDE_DESCENDANT, stderr: '', code: 0 }),
        claudeGetSessionMtimeMs: (id) => (id === SID_CLAUDE ? recentMtime : null),
        claudeGetSessionTailState: async () => ({ state: 'terminal_interrupted' as const, lastEntryTimestampMs: recentMtime }),
      });
      const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource], sessionCaptureService);
      const result = await resolver.getActivityStatus(buildWindow({ agentSessionId: SID_CLAUDE, workerType: 'claude' }));
      // 中断は完了ではない: interruptedAt だけが立ち、completedAt は null。
      expect(result).toEqual({ status: 'idle', completedAt: null, interruptedAt: recentMtime });
    });

    it('returns idle (never a fake working) when the tail record is terminal_final without a usable timestamp — P3', async () => {
      const panes: TmuxPaneInfo[] = [
        { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'node' },
      ];
      const recentMtime = Date.now() - 5 * 1000;
      const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService } = buildDeps({
        listAllPanes: async () => panes,
        getPanePid: async () => 9000,
        execCommand: async () => ({ stdout: PS_OUTPUT_WITH_CLAUDE_DESCENDANT, stderr: '', code: 0 }),
        claudeGetSessionMtimeMs: (id) => (id === SID_CLAUDE ? recentMtime : null),
        claudeGetSessionTailState: async () => ({ state: 'terminal_final' as const, lastEntryTimestampMs: null }),
      });
      const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource], sessionCaptureService);
      const result = await resolver.getActivityStatus(buildWindow({ agentSessionId: SID_CLAUDE, workerType: 'claude' }));
      // timestamp が無い＝再新性の根拠が無い。mtime へは倒さない（偽 working も偽完了も作らない）。
      expect(result).toEqual({ status: 'idle', completedAt: null, interruptedAt: null });
    });

    it('returns idle when mtime is recent but the tail record is terminal_local (local command completion, e.g. /model — codex review Important 1)', async () => {
      const panes: TmuxPaneInfo[] = [
        { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'node' },
      ];
      const recentMtime = Date.now() - 5 * 1000;
      const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService } = buildDeps({
        listAllPanes: async () => panes,
        getPanePid: async () => 9000,
        execCommand: async () => ({ stdout: PS_OUTPUT_WITH_CLAUDE_DESCENDANT, stderr: '', code: 0 }),
        claudeGetSessionMtimeMs: (id) => (id === SID_CLAUDE ? recentMtime : null),
        claudeGetSessionTailState: async () => ({ state: 'terminal_local' as const, lastEntryTimestampMs: null }),
      });
      const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource], sessionCaptureService);
      const result = await resolver.getActivityStatus(buildWindow({ agentSessionId: SID_CLAUDE, workerType: 'claude' }));
      expect(result.status).toBe('idle');
    });

    it('falls back to the task-linked session when the window has no agentSessionId of its own', async () => {
      const panes: TmuxPaneInfo[] = [
        { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'node' },
      ];
      const recentMtime = Date.now() - 5 * 1000;
      const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService } = buildDeps({
        listAllPanes: async () => panes,
        getPanePid: async () => 9000,
        execCommand: async () => ({ stdout: PS_OUTPUT_WITH_CLAUDE_DESCENDANT, stderr: '', code: 0 }),
        findById: () => buildTask({ agentSessionId: SID_CLAUDE }),
        claudeGetSessionMtimeMs: (id) => (id === SID_CLAUDE ? recentMtime : null),
        claudeGetSessionTailState: async () => ({ state: 'in_progress' as const, lastEntryTimestampMs: recentMtime }),
      });
      const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource], sessionCaptureService);
      const result = await resolver.getActivityStatus(buildWindow({ agentSessionId: null, taskId: 7, workerType: 'claude' }));
      expect(result.status).toBe('working');
    });

    describe('respawn false-positive fix (Issue #338): freshness must come from the tail entry timestamp, not file mtime', () => {
      it('returns idle right after `claude --resume` even though mtime is fresh, when the last meaningful entry is stale (housekeeping-only respawn)', async () => {
        const panes: TmuxPaneInfo[] = [
          { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'node' },
        ];
        // mtime はリスポーン直後の housekeeping 書き込みで新しいが、末尾の意味あるエントリ
        // （terminal_final = 前回セッションの最終応答）は何分も前のまま、というリスポーン直後の実観測を再現する。
        const recentMtime = Date.now() - 5 * 1000;
        const staleEntryTimestampMs = Date.now() - 10 * 60 * 1000;
        const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService } = buildDeps({
          listAllPanes: async () => panes,
          getPanePid: async () => 9000,
          execCommand: async () => ({ stdout: PS_OUTPUT_WITH_CLAUDE_DESCENDANT, stderr: '', code: 0 }),
          claudeGetSessionMtimeMs: (id) => (id === SID_CLAUDE ? recentMtime : null),
          claudeGetSessionTailState: async () => ({ state: 'terminal_final' as const, lastEntryTimestampMs: staleEntryTimestampMs }),
        });
        const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource], sessionCaptureService);
        const result = await resolver.getActivityStatus(buildWindow({ agentSessionId: SID_CLAUDE, workerType: 'claude' }));
        expect(result.status).toBe('idle');
      });

      it('reports a completion (idle + completedAt) when the last meaningful entry is a fresh terminal_final', async () => {
        const panes: TmuxPaneInfo[] = [
          { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'node' },
        ];
        const recentMtime = Date.now() - 5 * 1000;
        const recentEntryTimestampMs = Date.now() - 5 * 1000;
        const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService } = buildDeps({
          listAllPanes: async () => panes,
          getPanePid: async () => 9000,
          execCommand: async () => ({ stdout: PS_OUTPUT_WITH_CLAUDE_DESCENDANT, stderr: '', code: 0 }),
          claudeGetSessionMtimeMs: (id) => (id === SID_CLAUDE ? recentMtime : null),
          claudeGetSessionTailState: async () => ({ state: 'terminal_final' as const, lastEntryTimestampMs: recentEntryTimestampMs }),
        });
        const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource], sessionCaptureService);
        const result = await resolver.getActivityStatus(buildWindow({ agentSessionId: SID_CLAUDE, workerType: 'claude' }));
        expect(result).toEqual({ status: 'idle', completedAt: recentEntryTimestampMs, interruptedAt: null });
      });

      it('returns working while the last meaningful entry is in_progress and fresh', async () => {
        const panes: TmuxPaneInfo[] = [
          { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'node' },
        ];
        const recentMtime = Date.now() - 5 * 1000;
        const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService } = buildDeps({
          listAllPanes: async () => panes,
          getPanePid: async () => 9000,
          execCommand: async () => ({ stdout: PS_OUTPUT_WITH_CLAUDE_DESCENDANT, stderr: '', code: 0 }),
          claudeGetSessionMtimeMs: (id) => (id === SID_CLAUDE ? recentMtime : null),
          claudeGetSessionTailState: async () => ({ state: 'in_progress' as const, lastEntryTimestampMs: recentMtime }),
        });
        const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource], sessionCaptureService);
        const result = await resolver.getActivityStatus(buildWindow({ agentSessionId: SID_CLAUDE, workerType: 'claude' }));
        expect(result.status).toBe('working');
      });

      it('does NOT fall back to mtime when lastEntryTimestampMs is null — a housekeeping-only session has no working evidence (P3 / codex Important 5)', async () => {
        const panes: TmuxPaneInfo[] = [
          { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'node' },
        ];
        const recentMtime = Date.now() - 5 * 1000;
        const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource, sessionCaptureService } = buildDeps({
          listAllPanes: async () => panes,
          getPanePid: async () => 9000,
          execCommand: async () => ({ stdout: PS_OUTPUT_WITH_CLAUDE_DESCENDANT, stderr: '', code: 0 }),
          claudeGetSessionMtimeMs: (id) => (id === SID_CLAUDE ? recentMtime : null),
          claudeGetSessionTailState: async () => ({ state: 'unknown' as const, lastEntryTimestampMs: null }),
        });
        const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource], sessionCaptureService);
        const result = await resolver.getActivityStatus(buildWindow({ agentSessionId: SID_CLAUDE, workerType: 'claude' }));
        expect(result).toEqual({ status: 'idle', completedAt: null, interruptedAt: null });
      });
    });
  });
});
