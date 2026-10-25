import { describe, it, expect, vi } from 'vitest';
import type { IFileOps } from '../../shared/fs/fileOps';
import { programFor, planNewWindowProgram } from './workerProgram';
import { commandLineLaunch } from './WorkerLaunch';
import type { ISessionStrategy, ISessionStrategyFactory } from './SessionStrategy';

function hostFiles() {
  const realpath = vi.fn(async () => 'C:\\Users\\me');
  return { files: () => ({ platform: 'win32', realpath }) as unknown as IFileOps, realpath };
}

function strategies(over: Partial<ISessionStrategy>): ISessionStrategyFactory {
  const strategy = { supportsSession: false, needsPostLaunchScan: false, buildNewSessionArgs: () => [], buildResumeArgs: () => [], buildRespawnLaunch: () => null, scanSessionId: async () => null, ...over } as ISessionStrategy;
  return { create: () => strategy };
}

describe('programFor', () => {
  it('is the argv, the UI terminal size and the directory; a ~ directory is expanded against the host home because pane.open does not', async () => {
    const { files, realpath } = hostFiles();
    expect(await programFor(commandLineLaunch('claude --x'), '~\\repo', files)).toEqual({ argv: ['claude', '--x'], cwd: 'C:\\Users\\me\\repo', cols: 120, rows: 40 });
    expect(realpath).toHaveBeenCalledTimes(1);
  });

  it('leaves an absolute directory alone without asking the host, and omits an unset one', async () => {
    const { files, realpath } = hostFiles();
    expect(await programFor(commandLineLaunch('claude'), 'C:\\work', files)).toMatchObject({ cwd: 'C:\\work' });
    expect(await programFor(commandLineLaunch('claude'), null, files)).not.toHaveProperty('cwd');
    expect(realpath).not.toHaveBeenCalled();
  });

  it('refuses an argument list the Windows shell would read again, before anything is made', async () => {
    await expect(programFor(commandLineLaunch("claude --model 'a&b'"), null, hostFiles().files)).rejects.toMatchObject({ code: 'unsupported_os' });
  });
});

describe('planNewWindowProgram', () => {
  const claude = strategies({ supportsSession: true, buildNewSessionArgs: (id) => ['--session-id', id] });

  it('gives an agent that takes a session id at launch one of its own, appended to the command, and reports it for the window row', async () => {
    const planned = await planNewWindowProgram(claude, hostFiles().files, { command: "claude --model 'opus'", workerType: 'claude', workingDirectory: 'C:\\work' });
    expect(planned.agentSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(planned.program).toMatchObject({ argv: ['claude', '--model', 'opus', '--session-id', planned.agentSessionId], cwd: 'C:\\work' });
  });

  it('keeps a session id the command already carries (a resumed one) and adds none', async () => {
    const planned = await planNewWindowProgram(claude, hostFiles().files, { command: 'claude --resume 11111111-1111-4111-8111-111111111111', workerType: 'claude', workingDirectory: null });
    expect(planned.agentSessionId).toBe('11111111-1111-4111-8111-111111111111');
    expect(planned.program.argv).toEqual(['claude', '--resume', '11111111-1111-4111-8111-111111111111']);
  });

  it('reads a quoted session id the way the program gets it, and records it', async () => {
    const planned = await planNewWindowProgram(claude, hostFiles().files, { command: "claude --resume '22222222-2222-4222-8222-222222222222'", workerType: 'claude', workingDirectory: null });
    expect(planned.agentSessionId).toBe('22222222-2222-4222-8222-222222222222');
    expect(planned.program.argv).toEqual(['claude', '--resume', '22222222-2222-4222-8222-222222222222']);
  });

  it('records nothing for a session value the window row would reject, and adds none of its own to a command that has one', async () => {
    const planned = await planNewWindowProgram(claude, hostFiles().files, { command: 'claude --resume my-name', workerType: 'claude', workingDirectory: null });
    expect(planned.agentSessionId).toBeNull();
    expect(planned.program.argv).toEqual(['claude', '--resume', 'my-name']);
  });

  it('does not take a --resume that is only text inside another quoted argument for the session flag', async () => {
    const planned = await planNewWindowProgram(claude, hostFiles().files, { command: "claude --append-system-prompt 'do --resume 33333333-3333-4333-8333-333333333333 never'", workerType: 'claude', workingDirectory: null });
    expect(planned.agentSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(planned.agentSessionId).not.toBe('33333333-3333-4333-8333-333333333333');
    expect(planned.program.argv.slice(-2)).toEqual(['--session-id', planned.agentSessionId]);
  });

  it('an agent whose session is found after launch (or a custom command) gets no id and its command as written', async () => {
    const codex = strategies({ supportsSession: true, needsPostLaunchScan: true });
    expect(await planNewWindowProgram(codex, hostFiles().files, { command: 'codex', workerType: 'codex', workingDirectory: null })).toMatchObject({ agentSessionId: null, program: { argv: ['codex'] } });
    expect(await planNewWindowProgram(strategies({}), hostFiles().files, { command: 'my-tool --x', workerType: 'generic', workingDirectory: null })).toMatchObject({ agentSessionId: null, program: { argv: ['my-tool', '--x'] } });
  });

  it('refuses a command with shell syntax as unsupported_os', async () => {
    await expect(planNewWindowProgram(strategies({}), hostFiles().files, { command: 'tool | tee x', workerType: 'generic', workingDirectory: null })).rejects.toMatchObject({ code: 'unsupported_os' });
  });
});
