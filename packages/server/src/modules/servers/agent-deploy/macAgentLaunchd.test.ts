import { describe, expect, it, vi } from 'vitest';
import { MacAgentLaunchd, renderMacAgentPlist } from './macAgentLaunchd';

describe('Mac agent launchd definition', () => {
  it('uses the background session, quotes paths and keeps the token out of the plist', () => {
    const plist = renderMacAgentPlist('/Users/a & b', '100.64.0.1', 3002, 'system');
    expect(plist).toContain('<key>LimitLoadToSessionType</key>\n  <string>Background</string>');
    expect(plist).toContain('/Users/a &amp; b/.azito/agent/current/run.sh');
    expect(plist).toContain('agent.env');
    expect(plist).not.toContain('AZITO_AGENT_TOKEN');
  });
  it('refuses to replace an unrelated loaded job', async () => {
    const execIsolated = vi.fn(async (_host: string, command: string) => {
      if (command.includes('id -u')) return { code: 0, stdout: '/Users/me\n501\n', stderr: '' };
      if (command.startsWith('if [ -f')) return { code: 0, stdout: 'AZITO_NO_PLIST', stderr: '' };
      if (command.includes('print')) return { code: 0, stdout: 'path = /Users/me/other.plist', stderr: '' };
      throw new Error(`Unexpected mutation: ${command}`);
    });
    const manager = await MacAgentLaunchd.connect({ execIsolated } as never, 'host');
    await expect(manager.start('100.64.0.1', 3002, 'secret', 'system')).rejects.toThrow(/not the managed agent/);
    expect(execIsolated.mock.calls.every((call) => !call[1].includes('bootstrap'))).toBe(true);
  });

  it('releases the cleanup lock without stopping or removing a different installation', async () => {
    const execIsolated = vi.fn(async (_host: string, command: string) => {
      if (command.includes('id -u')) return { code: 0, stdout: '/Users/me\n501\n', stderr: '' };
      if (command.startsWith('mkdir ')) return { code: 0, stdout: '', stderr: '' };
      if (command.startsWith('[ ')) return { code: 1, stdout: '', stderr: '' };
      if (command.startsWith('rm -rf ')) return { code: 0, stdout: '', stderr: '' };
      throw new Error(`Unexpected command: ${command}`);
    });
    const manager = await MacAgentLaunchd.connect({ execIsolated } as never, 'host');
    await expect(manager.cleanup('original')).rejects.toThrow(/id changed/);
    expect(execIsolated.mock.calls.at(-1)?.[1]).toContain('agent-cleanup.lock');
    expect(execIsolated.mock.calls.some((call) => call[1].includes('launchctl'))).toBe(false);
  });

});
