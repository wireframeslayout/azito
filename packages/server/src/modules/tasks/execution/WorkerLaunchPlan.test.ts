import { describe, it, expect, vi } from 'vitest';
import { planResumeWorkerLaunch, planResumeWorkerLaunchDaemonAware } from './WorkerLaunchPlan';
import type { ISessionStrategy, ISessionStrategyFactory } from '../../agents/SessionStrategy';
import { DaemonSessionChecker, type DaemonSessionVerdict } from '../../agents/claude/DaemonSessionChecker';
import { launchArgv } from '../../agents/WorkerLaunch';
import type { ServerConfig } from '../../servers/Server';

const SESSION_ID = '14b46fcb-1234-4def-8abc-000000000001';
const server = { name: 'local-server', type: 'local' } as unknown as ServerConfig;

/** The launch the real claude registry builds: argv without the resume arguments. */
function claudeBaseArgv(): string[] {
  return ['claude', '--dangerously-skip-permissions', '--strict-mcp-config'];
}

function unit(overrides: Partial<{ workerType: string; workerModel: string | null; workerExtraArgs: string | null }> = {}) {
  return { workerType: 'claude', workerModel: null, workerExtraArgs: null, ...overrides };
}

function strategyOf(overrides: Partial<Pick<ISessionStrategy, 'supportsSession' | 'conversationLogAgentType' | 'buildResumeArgs'>> = {}): ISessionStrategy {
  return {
    supportsSession: true,
    needsPostLaunchScan: false,
    conversationLogAgentType: 'claude',
    buildNewSessionArgs: (id) => ['--session-id', id],
    buildResumeArgs: (id) => ['--resume', id],
    buildRespawnLaunch: () => ({ kind: 'program', file: 'claude', args: [] }),
    scanSessionId: async () => null,
    ...overrides,
  };
}

function factoryOf(strategy: ISessionStrategy): ISessionStrategyFactory {
  return { create: vi.fn(() => strategy) };
}

function checkerOf(verdict: DaemonSessionVerdict): DaemonSessionChecker {
  return { check: vi.fn(async () => verdict) } as unknown as DaemonSessionChecker;
}

describe('planResumeWorkerLaunch', () => {
  it('keeps the plain resume launch (the daemon-unaware form is unchanged for its existing callers)', () => {
    const launch = planResumeWorkerLaunch(unit(), SESSION_ID, factoryOf(strategyOf()));
    expect(launchArgv(launch!)).toEqual([...claudeBaseArgv(), '--resume', SESSION_ID]);
  });
});

describe('planResumeWorkerLaunchDaemonAware', () => {
  it('attaches when the daemon holds the conversation (Issue #540)', async () => {
    const checker = checkerOf({ status: 'attach', attachId: '14b46fcb' });
    const plan = await planResumeWorkerLaunchDaemonAware(unit(), SESSION_ID, factoryOf(strategyOf()), checker, server);
    expect(launchArgv(plan!.launch)).toEqual(['claude', 'attach', '14b46fcb']);
    expect(plan!.daemonCheckUnknownReason).toBe('');
  });

  it('resumes when the daemon does not hold it', async () => {
    const plan = await planResumeWorkerLaunchDaemonAware(unit(), SESSION_ID, factoryOf(strategyOf()), checkerOf({ status: 'resume' }), server);
    expect(launchArgv(plan!.launch)).toEqual([...claudeBaseArgv(), '--resume', SESSION_ID]);
    expect(plan!.daemonCheckUnknownReason).toBe('');
  });

  it('resumes when the check cannot be asked, and carries the reason out for the caller to log', async () => {
    const plan = await planResumeWorkerLaunchDaemonAware(unit(), SESSION_ID, factoryOf(strategyOf()), checkerOf({ status: 'unknown', reason: 'no agents subcommand' }), server);
    expect(launchArgv(plan!.launch)).toEqual([...claudeBaseArgv(), '--resume', SESSION_ID]);
    expect(plan!.daemonCheckUnknownReason).toBe('no agents subcommand');
  });

  it('does not ask the daemon for a codex worker (no daemon holds a codex conversation)', async () => {
    const checker = checkerOf({ status: 'attach', attachId: '14b46fcb' });
    const plan = await planResumeWorkerLaunchDaemonAware(unit({ workerType: 'codex' }), SESSION_ID, factoryOf(strategyOf({ conversationLogAgentType: 'codex' })), checker, server);
    expect(launchArgv(plan!.launch)).toEqual(['codex', '--dangerously-bypass-approvals-and-sandbox', '-c', 'check_for_update_on_startup=false', '-c', 'mcp_servers.azt-mcp.enabled=false', '-c', 'mcp_servers.azt-mcp.command=azt-mcp-disabled', '--resume', SESSION_ID]);
    expect(plan!.daemonCheckUnknownReason).toBe('');
  });

  it('runs the check with the conversation CLAUDE_CONFIG_DIR when the caller knows one', async () => {
    const checker = checkerOf({ status: 'resume' });
    await planResumeWorkerLaunchDaemonAware(unit(), SESSION_ID, factoryOf(strategyOf()), checker, server, '/home/me/.claude-project');
    expect((checker.check as ReturnType<typeof vi.fn>).mock.calls[0][2]).toBe('/home/me/.claude-project');
  });

  it('skips the check for a missing session id', async () => {
    const checker = checkerOf({ status: 'attach', attachId: '14b46fcb' });
    const plan = await planResumeWorkerLaunchDaemonAware(unit(), null, factoryOf(strategyOf()), checker, server);
    expect(launchArgv(plan!.launch)).toEqual(claudeBaseArgv());
    expect((checker.check as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('skips the check for a worker without session support', async () => {
    const checker = checkerOf({ status: 'attach', attachId: '14b46fcb' });
    const plan = await planResumeWorkerLaunchDaemonAware(unit(), SESSION_ID, factoryOf(strategyOf({ supportsSession: false })), checker, server);
    expect(launchArgv(plan!.launch)).toEqual(claudeBaseArgv());
    expect((checker.check as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});
