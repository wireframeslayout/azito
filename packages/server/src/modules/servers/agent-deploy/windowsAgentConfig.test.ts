import { describe, expect, it } from 'vitest';
import { DEFAULT_WINDOWS_AGENT_OPTIONS, resolveWindowsAgentOptions } from './windowsAgentConfig';

describe('resolveWindowsAgentOptions', () => {
  it('defaults to the real agent: task AzitoAgent, folder .azito\\agent, port 3002', () => {
    expect(resolveWindowsAgentOptions({})).toEqual({ taskName: 'AzitoAgent', dir: '.azito\\agent', port: 3002, misaoTaskName: 'AzitoMisao', misaoDir: '.azito\\misao' });
    expect(resolveWindowsAgentOptions({ AZITO_WIN_AGENT_TASK_NAME: '', AZITO_WIN_AGENT_DIR: '', AZITO_WIN_AGENT_PORT: '' })).toEqual(DEFAULT_WINDOWS_AGENT_OPTIONS);
  });

  it('takes a task name, a folder (either separator) and a port, for an agent tried out beside the real one', () => {
    expect(resolveWindowsAgentOptions({ AZITO_WIN_AGENT_TASK_NAME: 'w806-AzitoAgent', AZITO_WIN_AGENT_DIR: 'w806/agent', AZITO_WIN_AGENT_PORT: '3902', AZITO_WIN_MISAO_TASK_NAME: 'w806-AzitoMisao', AZITO_WIN_MISAO_DIR: 'w806/misao' }))
      .toEqual({ taskName: 'w806-AzitoAgent', dir: 'w806\\agent', port: 3902, misaoTaskName: 'w806-AzitoMisao', misaoDir: 'w806\\misao' });
  });

  it.each([
    [{ AZITO_WIN_AGENT_TASK_NAME: 'bad name' }, /AZITO_WIN_AGENT_TASK_NAME/],
    [{ AZITO_WIN_AGENT_TASK_NAME: '-x' }, /AZITO_WIN_AGENT_TASK_NAME/],
    [{ AZITO_WIN_AGENT_DIR: '..\\x' }, /AZITO_WIN_AGENT_DIR/],
    [{ AZITO_WIN_AGENT_DIR: 'C:\\x' }, /AZITO_WIN_AGENT_DIR/],
    [{ AZITO_WIN_AGENT_DIR: 'a b' }, /AZITO_WIN_AGENT_DIR/],
    [{ AZITO_WIN_AGENT_DIR: '%TEMP%' }, /AZITO_WIN_AGENT_DIR/],
    [{ AZITO_WIN_MISAO_TASK_NAME: 'bad name' }, /AZITO_WIN_MISAO_TASK_NAME/],
    [{ AZITO_WIN_MISAO_DIR: '..\\x' }, /AZITO_WIN_MISAO_DIR/],
    [{ AZITO_WIN_AGENT_PORT: '80' }, /AZITO_WIN_AGENT_PORT/],
    [{ AZITO_WIN_AGENT_PORT: 'abc' }, /AZITO_WIN_AGENT_PORT/],
  ])('refuses %j instead of replacing it with a default', (env, message) => {
    expect(() => resolveWindowsAgentOptions(env)).toThrow(message);
  });
});
