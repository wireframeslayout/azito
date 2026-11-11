import { describe, expect, it } from 'vitest';
import { parseWorkerLaunchRecord } from './workerLaunchRecord';
import { buildClaudeLaunch, buildClaudeAttachLaunch } from '../agents/claude/launchCommand';
import { buildCodexLaunch } from '../agents/codex/launchCommand';
import { launchArgv } from '../agents/WorkerLaunch';

describe('worker launch records', () => {
  it('records allowed permission and model settings', () => {
    expect(parseWorkerLaunchRecord("claude --permission-mode 'acceptEdits' --model 'sonnet-4.5' --verbose")).toEqual({ workerType: 'claude', args: ['--permission-mode', 'acceptEdits', '--model', 'sonnet-4.5', '--verbose'] });
    const bypass = parseWorkerLaunchRecord('claude --dangerously-skip-permissions');
    expect(bypass?.args).toEqual(['--dangerously-skip-permissions']);
    expect(launchArgv(buildClaudeLaunch({ blockMcp: false, defaultPermissionFlags: false, recordedArgs: bypass!.args }, 'abc'))).toEqual(['claude', '--resume', 'abc', '--dangerously-skip-permissions']);
  });
  it('accepts current CLI approval flags and bracketed models', () => {
    expect(parseWorkerLaunchRecord("claude --permission-mode auto --model 'claude-opus-5-5[1m]'")?.args).toEqual(['--permission-mode', 'auto', '--model', 'claude-opus-5-5[1m]']);
    expect(parseWorkerLaunchRecord('codex --approve-for-me -a on-request -s workspace-write')?.args).toEqual(['--approve-for-me', '-a', 'on-request', '-s', 'workspace-write']);
    expect(parseWorkerLaunchRecord('codex --full-auto')).toBeNull();
  });
  it('rejects the whole launch if an argument is outside the allowlist', () => {
    expect(parseWorkerLaunchRecord('claude --dangerously-skip-permissions --append-system-prompt secret')).toBeNull();
    expect(parseWorkerLaunchRecord('claude --model secret/path')).toBeNull();
    expect(parseWorkerLaunchRecord('TOKEN=secret claude')).toBeNull();
    expect(parseWorkerLaunchRecord('claude | other')).toBeNull();
    expect(parseWorkerLaunchRecord('claude --model -c')).toBeNull();
    expect(parseWorkerLaunchRecord('codex -m --config')).toBeNull();
  });
  it('never adds bypass to an unknown launch, while preserving session selection', () => {
    expect(launchArgv(buildClaudeLaunch({ blockMcp: false, defaultPermissionFlags: false }, 'abc', true))).toEqual(['claude', '--session-id', 'abc']);
    expect(launchArgv(buildClaudeLaunch({ blockMcp: false, defaultPermissionFlags: false }, 'abc'))).toEqual(['claude', '--resume', 'abc']);
    expect(launchArgv(buildClaudeAttachLaunch('abc'))).toEqual(['claude', 'attach', 'abc']);
  });
  it("keeps only the window's stored model when there is no record, never a permission flag", () => {
    expect(launchArgv(buildClaudeLaunch({ model: 'opus', blockMcp: false, defaultPermissionFlags: false }, 'abc'))).toEqual(['claude', '--resume', 'abc', '--model', 'opus']);
    const codex = launchArgv(buildCodexLaunch({ model: 'gpt-5', blockMcp: false, defaultPermissionFlags: false }));
    expect(codex.slice(-2)).toEqual(['--model', 'gpt-5']);
    expect(codex).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    const recordedWithoutModel = { workerType: 'claude' as const, args: ['--verbose'] };
    expect(launchArgv(buildClaudeLaunch({ model: 'opus', recordedArgs: recordedWithoutModel.args, blockMcp: false, defaultPermissionFlags: false }))).toEqual(['claude', '--verbose']);
  });
});
