import { describe, expect, it } from 'vitest';
import { parseWorkerLaunchRecord, buildRecordedClaudeLaunch } from './workerLaunchRecord';
import { launchArgv } from '../agents/WorkerLaunch';

describe('worker launch records', () => {
  it('records allowed permission and model settings', () => {
    expect(parseWorkerLaunchRecord("claude --permission-mode 'acceptEdits' --model 'sonnet-4.5' --verbose")).toEqual({ workerType: 'claude', args: ['--permission-mode', 'acceptEdits', '--model', 'sonnet-4.5', '--verbose'] });
    const bypass = parseWorkerLaunchRecord('claude --dangerously-skip-permissions');
    expect(bypass?.args).toEqual(['--dangerously-skip-permissions']);
    expect(launchArgv(buildRecordedClaudeLaunch(bypass, 'abc', false))).toEqual(['claude', '--resume', 'abc', '--dangerously-skip-permissions']);
  });
  it('rejects the whole launch if an argument is outside the allowlist', () => {
    expect(parseWorkerLaunchRecord('claude --dangerously-skip-permissions --append-system-prompt secret')).toBeNull();
    expect(parseWorkerLaunchRecord('claude --model secret/path')).toBeNull();
    expect(parseWorkerLaunchRecord('TOKEN=secret claude')).toBeNull();
    expect(parseWorkerLaunchRecord('claude | other')).toBeNull();
  });
  it('never adds bypass to an unknown launch, while preserving session selection', () => {
    expect(launchArgv(buildRecordedClaudeLaunch(null, 'abc', false, 'new'))).toEqual(['claude', '--session-id', 'abc']);
    expect(launchArgv(buildRecordedClaudeLaunch(null, 'abc', false))).toEqual(['claude', '--resume', 'abc']);
    expect(launchArgv(buildRecordedClaudeLaunch(null, 'abc', false, 'attach'))).toEqual(['claude', 'attach', 'abc']);
  });
});
