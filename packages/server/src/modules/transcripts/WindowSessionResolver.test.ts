import { describe, it, expect } from 'vitest';
import { WindowSessionResolver } from './WindowSessionResolver';
import type { ITaskRepository, Task } from '../tasks/Task';
import type { TmuxClient, TmuxPaneInfo, TmuxSession } from '../tmux/TmuxClient';
import type { IServerRepository, ServerConfig } from '../servers/Server';
import type { TranscriptSource, SessionSummary } from './sources/TranscriptSource';
import type { Window } from './../windows/Window';

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
  servers?: ServerConfig[];
  claudeGetSessionCwd?: TranscriptSource['getSessionCwd'];
  claudeListSessions?: TranscriptSource['listSessions'];
  codexListSessions?: TranscriptSource['listSessions'];
} = {}) {
  const taskRepo = {
    findById: opts.findById ?? (() => null),
  } as unknown as ITaskRepository;

  const tmuxClient = {
    listAllPanes: opts.listAllPanes ?? (async () => []),
    listSessions: opts.listSessions ?? (async () => []),
  } as unknown as TmuxClient;

  const serverRepo = {
    findByName: (name: string) => (opts.servers ?? [LOCAL_SERVER]).find((s) => s.name === name) ?? null,
  } as unknown as IServerRepository;

  const claudeSource = {
    agentType: 'claude',
    getSessionCwd: opts.claudeGetSessionCwd ?? (() => null),
    listSessions: opts.claudeListSessions ?? (() => []),
  } as unknown as TranscriptSource;

  const codexSource = {
    agentType: 'codex',
    getSessionCwd: () => null,
    listSessions: opts.codexListSessions ?? (() => []),
  } as unknown as TranscriptSource;

  return { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource };
}

describe('WindowSessionResolver', () => {
  it('returns unsupported_server for a non-local server', async () => {
    const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource } = buildDeps({ servers: [AGENT_SERVER] });
    const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource]);
    const result = await resolver.resolve(buildWindow({ serverName: 'agent1' }));
    expect(result).toEqual({ resolved: false, reason: 'unsupported_server', agentDetected: false });
  });

  it('returns unsupported_server when the window\'s server is not found', async () => {
    const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource } = buildDeps({ servers: [] });
    const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource]);
    const result = await resolver.resolve(buildWindow());
    expect(result).toEqual({ resolved: false, reason: 'unsupported_server', agentDetected: false });
  });

  it('best-effort: a non-local server still gets a paneId/agentType/agentDetected hint when panes exist', async () => {
    const panes: TmuxPaneInfo[] = [
      { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'claude' },
    ];
    const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource } = buildDeps({
      servers: [AGENT_SERVER],
      listAllPanes: async () => panes,
    });
    const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource]);
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
    const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource } = buildDeps({
      findById: () => buildTask({ agentSessionId: SID_CLAUDE }),
      listAllPanes: async () => panes,
      claudeGetSessionCwd: (id) => (id === SID_CLAUDE ? { cwd: '/proj' } : null),
    });
    const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource]);
    const result = await resolver.resolve(buildWindow({ taskId: 7 }));
    expect(result).toEqual({ resolved: true, agentType: 'claude', sessionId: SID_CLAUDE, paneId: '%1', agentDetected: true });
  });

  it('falls back to cwd matching when the linked task has no session file', async () => {
    const panes: TmuxPaneInfo[] = [
      { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'claude' },
    ];
    const recentMtime = Date.now() - 5 * 60 * 1000;
    const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource } = buildDeps({
      findById: () => buildTask({ agentSessionId: 'not-a-real-session' }),
      listAllPanes: async () => panes,
      claudeGetSessionCwd: () => null, // session file does not exist
      claudeListSessions: () => [
        { sessionId: SID_CLAUDE, agentType: 'claude', projectDir: 'p', cwd: '/proj', mtimeMs: recentMtime, sizeBytes: 1, preview: '' },
      ],
    });
    const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource]);
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
    const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource } = buildDeps({
      listAllPanes: async () => panes,
      claudeListSessions: () => [older],
      codexListSessions: () => [newer],
    });
    const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource]);
    const result = await resolver.resolve(buildWindow());
    expect(result).toEqual({ resolved: true, agentType: 'codex', sessionId: SID_CODEX, paneId: '%1', agentDetected: false });
  });

  it('returns no_recent_session when the only cwd-matching session is older than 30 minutes, with a best-effort pane hint', async () => {
    const panes: TmuxPaneInfo[] = [
      { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'node' },
    ];
    const staleMtime = Date.now() - 31 * 60 * 1000;
    const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource } = buildDeps({
      listAllPanes: async () => panes,
      claudeListSessions: () => [
        { sessionId: SID_CLAUDE, agentType: 'claude', projectDir: 'p', cwd: '/proj', mtimeMs: staleMtime, sizeBytes: 1, preview: '' },
      ],
    });
    const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource]);
    const result = await resolver.resolve(buildWindow());
    // window.workerType defaults to 'claude'; the single 'node' pane still matches the node-ish fallback
    // in selectPane, so a best-effort paneId is returned even though no session could be resolved.
    expect(result).toEqual({ resolved: false, reason: 'no_recent_session', paneId: '%1', agentType: 'claude', agentDetected: false });
  });

  it('returns no_recent_session when no session cwd matches any pane, with a best-effort pane hint', async () => {
    const panes: TmuxPaneInfo[] = [
      { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'node' },
    ];
    const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource } = buildDeps({
      listAllPanes: async () => panes,
      claudeListSessions: () => [
        { sessionId: SID_CLAUDE, agentType: 'claude', projectDir: 'p', cwd: '/other', mtimeMs: Date.now(), sizeBytes: 1, preview: '' },
      ],
    });
    const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource]);
    const result = await resolver.resolve(buildWindow());
    expect(result).toEqual({ resolved: false, reason: 'no_recent_session', paneId: '%1', agentType: 'claude', agentDetected: false });
  });

  it('returns no_recent_session with no pane hint when the window has no panes at all', async () => {
    const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource } = buildDeps({ listAllPanes: async () => [] });
    const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource]);
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
    const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource } = buildDeps({ listAllPanes: async () => panes });
    const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource]);
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
    const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource } = buildDeps({
      listAllPanes: async () => panes,
      claudeListSessions: () => [
        { sessionId: SID_CLAUDE, agentType: 'claude', projectDir: 'p', cwd: '/proj', mtimeMs: recentMtime, sizeBytes: 1, preview: '' },
      ],
    });
    const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource]);
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
    const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource } = buildDeps({
      listAllPanes: async () => panes,
      listSessions: async () => sessions,
      claudeListSessions: () => [
        { sessionId: SID_CLAUDE, agentType: 'claude', projectDir: 'p', cwd: '/proj', mtimeMs: recentMtime, sizeBytes: 1, preview: '' },
      ],
    });
    const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource]);
    const result = await resolver.resolve(buildWindow());
    expect(result).toEqual({ resolved: true, agentType: 'claude', sessionId: SID_CLAUDE, paneId: '%2', agentDetected: false });
  });

  it('priority 1: resolves a project-owned window (no taskId) via its own agent_session_id', async () => {
    const findById = () => { throw new Error('should not be called'); };
    const panes: TmuxPaneInfo[] = [
      { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'claude' },
    ];
    const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource } = buildDeps({
      findById,
      listAllPanes: async () => panes,
      claudeGetSessionCwd: (id) => (id === SID_CLAUDE ? { cwd: '/proj' } : null),
    });
    const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource]);
    const result = await resolver.resolve(buildWindow({ taskId: null, agentSessionId: SID_CLAUDE, workerType: 'claude' }));
    expect(result).toEqual({ resolved: true, agentType: 'claude', sessionId: SID_CLAUDE, paneId: '%1', agentDetected: true });
  });

  it('priority 1: resolves a window\'s own session via the codex source when workerType is codex', async () => {
    const panes: TmuxPaneInfo[] = [
      { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'codex' },
    ];
    const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource } = buildDeps({
      listAllPanes: async () => panes,
    });
    const codexWithSession = {
      ...codexSource,
      getSessionCwd: (id: string) => (id === SID_CODEX ? { cwd: '/proj' } : null),
    } as unknown as TranscriptSource;
    const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexWithSession]);
    const result = await resolver.resolve(buildWindow({ taskId: null, agentSessionId: SID_CODEX, workerType: 'codex' }));
    expect(result).toEqual({ resolved: true, agentType: 'codex', sessionId: SID_CODEX, paneId: '%1', agentDetected: true });
  });

  it('priority 1: falls back to trying all sources when the window workerType is unsupported (e.g. generic)', async () => {
    const panes: TmuxPaneInfo[] = [
      { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'codex' },
    ];
    const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource } = buildDeps({
      listAllPanes: async () => panes,
    });
    const codexWithSession = {
      ...codexSource,
      getSessionCwd: (id: string) => (id === SID_CODEX ? { cwd: '/proj' } : null),
    } as unknown as TranscriptSource;
    const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexWithSession]);
    const result = await resolver.resolve(buildWindow({ taskId: null, agentSessionId: SID_CODEX, workerType: 'generic' }));
    expect(result).toEqual({ resolved: true, agentType: 'codex', sessionId: SID_CODEX, paneId: '%1', agentDetected: true });
  });

  it('priority 2: falls back to trying all sources for the task session when window workerType is unknown', async () => {
    const panes: TmuxPaneInfo[] = [
      { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'codex' },
    ];
    const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource } = buildDeps({
      findById: () => buildTask({ agentSessionId: SID_CODEX }),
      listAllPanes: async () => panes,
    });
    const codexWithSession = {
      ...codexSource,
      getSessionCwd: (id: string) => (id === SID_CODEX ? { cwd: '/proj' } : null),
    } as unknown as TranscriptSource;
    const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexWithSession]);
    const result = await resolver.resolve(buildWindow({ taskId: 7, workerType: null }));
    expect(result).toEqual({ resolved: true, agentType: 'codex', sessionId: SID_CODEX, paneId: '%1', agentDetected: true });
  });

  it('pane selection: prefers a claude pane over an earlier node pane (exact command match)', async () => {
    const panes: TmuxPaneInfo[] = [
      { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'node' },
      { paneId: '%2', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 1, currentPath: '/proj', currentCommand: 'claude' },
    ];
    const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource } = buildDeps({
      findById: () => buildTask({ agentSessionId: SID_CLAUDE }),
      listAllPanes: async () => panes,
      claudeGetSessionCwd: (id) => (id === SID_CLAUDE ? { cwd: '/proj' } : null),
    });
    const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource]);
    const result = await resolver.resolve(buildWindow({ taskId: 7 }));
    expect(result).toEqual({ resolved: true, agentType: 'claude', sessionId: SID_CLAUDE, paneId: '%2', agentDetected: true });
  });

  it('pane selection: paneLayout meta (agentSessionId) wins over an unrelated exact-command pane, but agentDetected reflects the live command (Important #3)', async () => {
    const panes: TmuxPaneInfo[] = [
      { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 0, currentPath: '/proj', currentCommand: 'claude' },
      { paneId: '%2', sessionName: 'main', windowIndex: 0, windowName: 'w0', paneIndex: 1, currentPath: '/proj', currentCommand: 'bash' },
    ];
    const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource } = buildDeps({
      findById: () => buildTask({ agentSessionId: SID_CLAUDE }),
      listAllPanes: async () => panes,
      claudeGetSessionCwd: (id) => (id === SID_CLAUDE ? { cwd: '/proj' } : null),
    });
    const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource]);
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
    const { taskRepo, tmuxClient, serverRepo, claudeSource, codexSource } = buildDeps({
      findById,
      listAllPanes: async () => panes,
      claudeListSessions: () => [
        { sessionId: SID_CLAUDE, agentType: 'claude', projectDir: 'p', cwd: '/proj', mtimeMs: Date.now(), sizeBytes: 1, preview: '' },
      ],
    });
    const resolver = new WindowSessionResolver(taskRepo, tmuxClient, serverRepo, [claudeSource, codexSource]);
    const result = await resolver.resolve(buildWindow({ taskId: null }));
    expect(result).toEqual({ resolved: true, agentType: 'claude', sessionId: SID_CLAUDE, paneId: '%1', agentDetected: true });
  });
});
