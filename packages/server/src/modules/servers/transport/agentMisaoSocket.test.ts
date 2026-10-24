import { describe, expect, it } from 'vitest';
import { isWindowsMisaoPipe, managedEndpointOf, misaoFileNameOn, misaoRootOf, resolveAgentMisaoSocket, windowsMisaoPipe, type AgentMisaoHost, type AgentMisaoWindowsHost } from './agentMisaoSocket';

const WINDOWS: AgentMisaoWindowsHost = { systemRoot: 'C:\\Windows', userName: 'dev', misaoRoot: 'C:\\Users\\dev\\.azito\\misao' };
const HOST: AgentMisaoHost = { homeDir: 'C:\\Users\\dev', nodePath: 'C:\\node.exe', servicePath: '', platform: 'win32', arch: 'x64', windows: WINDOWS };

describe('the managed pipe of a Windows host', () => {
  it('is the name @misao/sdk gives for MISAO_DIR=<misao folder>, so the misao CLI with that MISAO_DIR reaches the same daemon', async () => {
    const sdk = await import('@misao/sdk');
    for (const [root, userName] of [[WINDOWS.misaoRoot, 'dev'], ['C:\\Users\\Dev User\\w806-misao', 'Dev User'], ['D:\\x', 'a'.repeat(40)], ['C:\\Users\\日本語\\.azito\\misao', '日本語']] as const) {
      const expected = sdk.resolveSocketPath({ env: { MISAO_DIR: root }, homeDir: 'C:\\Users\\whoever', platform: 'win32', userName });
      expect(windowsMisaoPipe(root, userName)).toBe(expected);
    }
  });

  it('differs per folder, ignoring case (the file system does)', () => {
    expect(windowsMisaoPipe('C:\\A\\misao', 'dev')).not.toBe(windowsMisaoPipe('C:\\B\\misao', 'dev'));
    expect(windowsMisaoPipe('C:\\A\\MISAO', 'dev')).toBe(windowsMisaoPipe('c:\\a\\misao', 'dev'));
  });

  it('is what a Windows agent relays to unless MISAO_SOCKET names another pipe', () => {
    expect(resolveAgentMisaoSocket({}, HOST.homeDir, WINDOWS).path).toBe(windowsMisaoPipe(WINDOWS.misaoRoot, 'dev'));
    expect(resolveAgentMisaoSocket({ MISAO_SOCKET: '' }, HOST.homeDir, WINDOWS).path).toBe(windowsMisaoPipe(WINDOWS.misaoRoot, 'dev'));
    expect(resolveAgentMisaoSocket({ MISAO_SOCKET: '\\\\.\\pipe\\mine' }, HOST.homeDir, WINDOWS).path).toBe('\\\\.\\pipe\\mine');
    expect(managedEndpointOf(HOST)).toBe(windowsMisaoPipe(WINDOWS.misaoRoot, 'dev'));
  });

  it.each(['C:\\x\\misao.sock', '/tmp/misao.sock', '\\\\.\\pipe\\', '\\\\.\\pipe\\a\\b', '\\\\.\\pipe\\a/b', `\\\\.\\pipe\\${'x'.repeat(260)}`])('refuses %j as a pipe instead of guessing', (value) => {
    expect(isWindowsMisaoPipe(value)).toBe(false);
    expect(() => resolveAgentMisaoSocket({ MISAO_SOCKET: value }, HOST.homeDir, WINDOWS)).toThrow(/named pipe/);
  });
});

describe('where misao lives on an agent', () => {
  it('is the folder the Windows agent reports, and <home>/.azito/misao elsewhere', () => {
    expect(misaoRootOf(HOST)).toBe(WINDOWS.misaoRoot);
    expect(misaoRootOf({ homeDir: '/home/u', nodePath: 'node', servicePath: '', platform: 'linux', arch: 'x64' })).toBe('/home/u/.azito/misao');
  });

  it('fails for a Windows agent that did not report its folder (an agent older than this hub)', () => {
    const { windows: _windows, ...bare } = HOST;
    expect(() => misaoRootOf(bare)).toThrow(/update the agent/);
    expect(() => managedEndpointOf(bare)).toThrow(/update the agent/);
  });

  it('names the executable misao.exe on Windows only', () => {
    expect(misaoFileNameOn('win32', 'misao')).toBe('misao.exe');
    expect(misaoFileNameOn('linux', 'misao')).toBe('misao');
    expect(misaoFileNameOn('win32', 'LICENSE')).toBe('LICENSE');
  });
});
