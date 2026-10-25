import { describe, expect, it } from 'vitest';
import { buildTaskXml } from '../../../shared/os/taskScheduler/taskDefinition';
import { DEFAULT_WINDOWS_AGENT_OPTIONS } from './windowsAgentConfig';
import { FakeWindowsHost } from './testing/fakeWindowsHost';
import { WindowsAgentDeployer, parsePruneOutput, versionOfTaskXml, windowsAgentLayout } from './WindowsAgentDeployer';

describe('versionOfTaskXml', () => {
  const taskFor = (entry: string): string => buildTaskXml({
    userId: 'PC\\dev', description: 'd', executable: 'C:\\Windows\\System32\\conhost.exe',
    args: ['--headless', 'C:\\Program Files\\nodejs\\node.exe', '--env-file=C:\\Users\\Server User\\.azito\\agent\\agent.env', entry], workingDirectory: 'C:\\Users\\Server User\\.azito\\agent',
    restartOnFailure: { intervalMinutes: 1, count: 999 },
  });

  it('reads the version folder the task runs the agent from, also from a path with spaces', () => {
    const layout = windowsAgentLayout('C:\\Users\\Server User', DEFAULT_WINDOWS_AGENT_OPTIONS, '0123456789ab');
    expect(versionOfTaskXml(taskFor(layout.entry))).toBe('0123456789ab');
  });

  it('is undefined for a definition that does not run the agent entry', () => {
    expect(versionOfTaskXml('<Task>previous definition</Task>')).toBeUndefined();
    expect(versionOfTaskXml(taskFor('C:\\tools\\other.js'))).toBeUndefined();
  });
});

describe('WindowsAgentDeployer.pruneOldVersions', () => {
  const HOST = { home: 'C:\\Users\\dev' };
  const deployerOn = (host: FakeWindowsHost): WindowsAgentDeployer => new WindowsAgentDeployer(host.exec, { putFile: async () => undefined, putBuffer: async () => undefined }, DEFAULT_WINDOWS_AGENT_OPTIONS);

  it('asks only for release folders (12 hex digits) other than the ones kept, and reads what was removed and what was in use', async () => {
    const host = new FakeWindowsHost({ sha256: 'a'.repeat(64), scriptOutput: { containing: 'REMOVED', stdout: 'REMOVED aaaaaaaaaaaa\r\nFAILED bbbbbbbbbbbb The process cannot access the file.\r\n' } });

    const result = await deployerOn(host).pruneOldVersions('ssh', HOST, ['cccccccccccc', 'dddddddddddd']);

    expect(result).toEqual({ removed: ['aaaaaaaaaaaa'], failed: [{ version: 'bbbbbbbbbbbb', reason: 'The process cannot access the file.' }] });
    const script = host.calls.at(-1)!.text;
    expect(script).toContain("$root = 'C:\\Users\\dev\\.azito\\agent'");
    expect(script).toContain("$keep = @('cccccccccccc', 'dddddddddddd')");
    expect(script).toContain("-match '^[0-9a-f]{12}$'");
    expect(script).toContain('-notcontains $_.Name');
  });

  it('throws with the reason when the script itself fails', async () => {
    const host = new FakeWindowsHost({ sha256: 'a'.repeat(64), failScript: { containing: 'REMOVED', stderr: 'boom' } });
    await expect(deployerOn(host).pruneOldVersions('ssh', HOST, ['cccccccccccc'])).rejects.toThrow(/Removing the old agent versions failed.*boom/);
  });
});

describe('parsePruneOutput', () => {
  it('ignores lines that are neither REMOVED nor FAILED', () => {
    expect(parsePruneOutput('banner\r\nREMOVED aaaaaaaaaaaa\r\n')).toEqual({ removed: ['aaaaaaaaaaaa'], failed: [] });
  });
});
