import { describe, expect, it } from 'vitest';
import { parseWorkerLaunchRecord, buildRecordedClaudeLaunch, buildRecordedCodexLaunch } from './workerLaunchRecord';
import { launchArgv } from '../agents/WorkerLaunch';

describe('worker launch records', () => {
  it('records allowed permission and model settings', () => {
    expect(parseWorkerLaunchRecord("claude --permission-mode 'acceptEdits' --model 'sonnet-4.5' --verbose")).toEqual({ workerType: 'claude', args: ['--permission-mode', 'acceptEdits', '--model', 'sonnet-4.5', '--verbose'] });
    const bypass = parseWorkerLaunchRecord('claude --dangerously-skip-permissions');
    expect(bypass?.args).toEqual(['--dangerously-skip-permissions']);
    expect(launchArgv(buildRecordedClaudeLaunch(bypass, 'opus', 'abc', false))).toEqual(['claude', '--resume', 'abc', '--dangerously-skip-permissions']);
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
    expect(launchArgv(buildRecordedClaudeLaunch(null, null, 'abc', false, 'new'))).toEqual(['claude', '--session-id', 'abc']);
    expect(launchArgv(buildRecordedClaudeLaunch(null, null, 'abc', false))).toEqual(['claude', '--resume', 'abc']);
    expect(launchArgv(buildRecordedClaudeLaunch(null, null, 'abc', false, 'attach'))).toEqual(['claude', 'attach', 'abc']);
  });
  it("keeps only the window's stored model when there is no record, never a permission flag", () => {
    expect(launchArgv(buildRecordedClaudeLaunch(null, 'opus', 'abc', false))).toEqual(['claude', '--resume', 'abc', '--model', 'opus']);
    const codex = launchArgv(buildRecordedCodexLaunch(null, 'gpt-5', null, false));
    expect(codex.slice(-2)).toEqual(['--model', 'gpt-5']);
    expect(codex).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    const recordedWithoutModel = { workerType: 'claude' as const, args: ['--verbose'] };
    expect(launchArgv(buildRecordedClaudeLaunch(recordedWithoutModel, 'opus', null, false))).toEqual(['claude', '--verbose']);
  });
});
