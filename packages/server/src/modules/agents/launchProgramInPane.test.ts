import { describe, it, expect, vi } from 'vitest';
import { asPaneHandle } from '@azito/shared';
import type { ServerConfig } from '../servers/Server';
import type { IMuxClient } from '../tmux/IMuxClient';
import type { IFileOps } from '../../shared/fs/fileOps';
import { launchProgramInPane } from './launchProgramInPane';
import { commandLineLaunch } from './WorkerLaunch';

const server = { name: 'win' } as ServerConfig;
const shell = asPaneHandle('p_shell');

function setup() {
  const replacePaneWithProgram = vi.fn(async (..._args: unknown[]) => asPaneHandle('p_new'));
  const driver = { replacePaneWithProgram } as unknown as IMuxClient;
  const realpath = vi.fn(async () => 'C:\\Users\\me');
  const files = { platform: 'win32', realpath } as unknown as IFileOps;
  return { driver, replacePaneWithProgram, files: () => files, realpath };
}

describe('launchProgramInPane', () => {
  it('expands a ~ working directory against the host home, since pane.open does not', async () => {
    const { driver, replacePaneWithProgram, files } = setup();
    await launchProgramInPane(driver, server, shell, commandLineLaunch('claude'), { cwd: '~\\repo', paneEnv: {}, files });
    expect(replacePaneWithProgram.mock.calls[0][2]).toMatchObject({ cwd: 'C:\\Users\\me\\repo' });
  });

  it('leaves an absolute directory alone without asking the host', async () => {
    const { driver, replacePaneWithProgram, files, realpath } = setup();
    await launchProgramInPane(driver, server, shell, commandLineLaunch('claude'), { cwd: 'C:\\work', paneEnv: {}, files });
    expect(replacePaneWithProgram.mock.calls[0][2]).toMatchObject({ cwd: 'C:\\work' });
    expect(realpath).not.toHaveBeenCalled();
  });

  it('refuses an argument list the Windows shell would read again, before the mux is asked', async () => {
    const { driver, replacePaneWithProgram, files } = setup();
    await expect(launchProgramInPane(driver, server, shell, commandLineLaunch("claude --model 'a&b'"), { cwd: null, paneEnv: {}, files })).rejects.toMatchObject({ code: 'unsupported_os' });
    expect(replacePaneWithProgram).not.toHaveBeenCalled();
  });
});
