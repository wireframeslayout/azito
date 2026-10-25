import type { IServerTransport } from '../../servers/transport/ServerTransport';
import { ensureClaudeBypassAccepted, ensureClaudeLegacyBypassAccepted, type EnsureClaudeBypassAcceptedResult } from './ensureClaudeBypassAccepted';

/**
 * What to do on the host before a Claude worker is started with `--dangerously-skip-permissions` (every Claude launch carries it): accept the
 * "Bypass Permissions mode" dialog in the host's Claude Code settings, so a host that has not run it before does not stop at the dialog.
 * (The folder trust is registered separately, with the worktree: `ensureClaudeTrust`.)
 *
 * Call it from every task boundary that starts a Claude worker, after the execution gate was verified and with the transport of the server
 * the worker will actually run on; for a worker started as a program (Windows) that is before the window is opened.
 * It never throws: a step that fails or is skipped is reported through `report` (the launch goes on, and the dialog, if it still appears, is
 * detected and fails the task with a reason).
 */
export async function prepareClaudeLaunch(transport: IServerTransport, report: (entry: Record<string, unknown>) => void): Promise<void> {
  await acceptBypass('settings.json', () => ensureClaudeBypassAccepted(transport), report);
  await acceptBypass('.claude.json', () => ensureClaudeLegacyBypassAccepted(transport), report);
}

async function acceptBypass(file: string, run: () => Promise<EnsureClaudeBypassAcceptedResult>, report: (entry: Record<string, unknown>) => void): Promise<void> {
  try {
    const result = await run();
    if (result.action === 'accepted') report({ type: 'claude_bypass_accepted', file });
    else if (result.action === 'skipped') report({ type: 'claude_bypass_skipped', file, reason: result.reason });
  } catch (err) {
    report({ type: 'claude_bypass_failed', file, reason: err instanceof Error ? err.message : String(err) });
  }
}
