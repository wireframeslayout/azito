import { describe, expect, it, vi } from 'vitest';
import { MacAgentLaunchd, renderMacAgentPlist } from './macAgentLaunchd';

function fakeExec(fn: (host: string, command: string) => Promise<{ stdout: string; stderr: string; code: number }>) {
  return vi.fn(async (host: string, command: string) => {
    const inner = unwrapCommand(command);
    const marker = /; printf '\\n(AZITO_EXIT_[a-f0-9]+):%s\\n' "\$\?"$/.exec(inner);
    const result = await fn(host, marker ? inner.slice(0, marker.index) : command);
    return marker ? { ...result, stdout: `${result.stdout}\n${marker[1]}:${result.code}\n`, code: 0 } : result;
  });
}

function unwrapCommand(command: string): string {
  const prefix = "/bin/bash -c '";
  return command.startsWith(prefix) ? command.slice(prefix.length, -1).replaceAll("'\\''", "'") : command;
}

// Shape of launchctl print output: https://getlaunchmon.com/guides/launchctl-print-output-explained
const managedJob = `user/501/com.azito.agent = {
	active count = 1
	path = /Users/me/Library/LaunchAgents/com.azito.agent.plist
	type = LaunchAgent
	state = running
	program = /bin/sh
	arguments = {
		/bin/sh
		-c
		exec /bin/bash /Users/me/.azito/agent/current/run.sh
	}
}`;
const absentJob = 'Bad request.\nCould not find service "com.azito.agent" in domain for user gui: 501\n';

describe('Mac agent launchd definition', () => {
  it('uses the background session, quotes paths and keeps the token out of the plist', () => {
    const plist = renderMacAgentPlist('/Users/a & b', '100.64.0.1', 3002, 'system');
    expect(plist).toContain('<key>LimitLoadToSessionType</key>\n  <string>Background</string>');
    expect(plist).toContain('/Users/a &amp; b/.azito/agent/current/run.sh');
    expect(plist).toContain('agent.env');
    expect(plist).not.toContain('AZITO_AGENT_TOKEN');
  });
  it('refuses to replace an unrelated loaded job', async () => {
    const execIsolated = fakeExec(async (_host: string, rawCommand: string) => {
      const command = unwrapCommand(rawCommand);
      if (command.includes('id -u')) return { code: 0, stdout: '/Users/me\n501\n', stderr: '' };
      if (command.startsWith('if [ -f')) return { code: 0, stdout: 'AZITO_NO_PLIST', stderr: '' };
      if (command.includes('print')) return { code: 0, stdout: `${command.includes('gui/501') ? 'gui' : 'user'}/501/com.azito.agent = {\npath = /Users/me/other.plist`, stderr: '' };
      throw new Error(`Unexpected mutation: ${command}`);
    });
    const manager = await MacAgentLaunchd.connect({ execIsolated } as never, 'host');
    await expect(manager.start('100.64.0.1', 3002, 'secret', 'system')).rejects.toThrow(/not the managed agent/);
    expect(execIsolated.mock.calls.every((call) => !unwrapCommand(unwrapCommand(call[1])).includes('bootstrap'))).toBe(true);
  });

  it('releases the cleanup lock without stopping or removing a different installation', async () => {
    const execIsolated = fakeExec(async (_host: string, rawCommand: string) => {
      const command = unwrapCommand(rawCommand);
      if (command.includes('id -u')) return { code: 0, stdout: '/Users/me\n501\n', stderr: '' };
      if (command.startsWith('mkdir ')) return { code: 0, stdout: '', stderr: '' };
      if (command.startsWith('[ ')) return { code: 113, stdout: '', stderr: absentJob };
      if (command.startsWith('rm -rf ')) return { code: 0, stdout: '', stderr: '' };
      throw new Error(`Unexpected command: ${command}`);
    });
    const manager = await MacAgentLaunchd.connect({ execIsolated } as never, 'host');
    await expect(manager.cleanup('original')).rejects.toThrow(/id changed/);
    expect(execIsolated.mock.calls.at(-1)?.[1]).toContain('agent-cleanup.lock');
    expect(execIsolated.mock.calls.some((call) => unwrapCommand(unwrapCommand(call[1])).includes('launchctl'))).toBe(false);
  });

  it('restores a previous definition and restarts its job when bootstrap fails', async () => {
    let loaded = true;
    const home = '/Users/me';
    const execIsolated = fakeExec(async (_host: string, rawCommand: string) => {
      const command = unwrapCommand(rawCommand);
      if (command.includes('id -u')) return { code: 0, stdout: `${home}\n501\n`, stderr: '' };
      if (command.startsWith('if [ -f') && command.includes('com.azito.agent.plist') && !command.includes('agent-launchd-backup')) return { code: 0, stdout: renderMacAgentPlist(home, '100.64.0.1', 3002, 'system'), stderr: '' };
      if (command.includes("'launchctl' 'print'")) return command.includes('user/501') && loaded ? { code: 0, stdout: managedJob, stderr: '' } : { code: 113, stdout: '', stderr: absentJob };
      if (command.includes('agent-launchd-backup.XXXXXX')) return { code: 0, stdout: `${home}/.azito/agent-launchd-backup.abc123\n`, stderr: '' };
      if (command.includes("'launchctl' 'bootout'")) { loaded = false; return { code: 0, stdout: '', stderr: '' }; }
      if (command.includes("'launchctl' 'bootstrap'")) {
        const count = execIsolated.mock.calls.filter((call) => unwrapCommand(unwrapCommand(call[1])).includes("'launchctl' 'bootstrap'")).length;
        return { code: count === 1 ? 1 : 0, stdout: '', stderr: 'failed' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    const manager = await MacAgentLaunchd.connect({ execIsolated } as never, 'host');
    await expect(manager.start('100.64.0.2', 3002, 'secret', 'system')).rejects.toThrow(/bootstrap/);
    expect(execIsolated.mock.calls.some((call) => unwrapCommand(unwrapCommand(call[1])).includes('/plist') && unwrapCommand(unwrapCommand(call[1])).includes('cp -p'))).toBe(true);
    expect(execIsolated.mock.calls.filter((call) => unwrapCommand(unwrapCommand(call[1])).includes("'launchctl' 'bootstrap'")).length).toBe(2);
  });

  it('has no installation once the agent folder is gone, so nothing would be started again', async () => {
    const execIsolated = fakeExec(async (_host: string, rawCommand: string) => {
      const command = unwrapCommand(rawCommand);
      if (command.includes('id -u')) return { code: 0, stdout: '/Users/me\n501\n', stderr: '' };
      if (command.startsWith('if [ -f') && command.includes('install.id')) return { code: 0, stdout: 'AZITO_ABSENT', stderr: '' };
      if (command.startsWith('if [ -f')) return { code: 0, stdout: 'AZITO_NO_PLIST', stderr: '' };
      if (command.includes("'launchctl' 'print'")) return { code: 113, stdout: '', stderr: absentJob };
      throw new Error(`Unexpected command: ${command}`);
    });
    const manager = await MacAgentLaunchd.connect({ execIsolated } as never, 'host');
    await expect(manager.hasInstallation()).resolves.toBe(false);
  });

  it('restores the previous current link only when the new version still owns it', async () => {
    const execIsolated = fakeExec(async (_host: string, rawCommand: string) => {
      const command = unwrapCommand(rawCommand);
      if (command.includes('id -u')) return { code: 0, stdout: '/Users/me\n501\n', stderr: '' };
      if (command.startsWith('if [ -L')) return { code: 0, stdout: '/Users/me/.azito/agent/old\n', stderr: '' };
      if (command.startsWith('[ ')) return { code: 113, stdout: '', stderr: absentJob };
      throw new Error(`Unexpected command: ${command}`);
    });
    const manager = await MacAgentLaunchd.connect({ execIsolated } as never, 'host');
    const previous = await manager.readCurrent();
    expect(previous).toBe('/Users/me/.azito/agent/old');
    await expect(manager.restoreCurrent(previous, 'new')).rejects.toThrow(/changed/);
    expect(execIsolated.mock.calls.at(-1)?.[1]).toContain('readlink');
  });

});
