import { describe, expect, it } from 'vitest';
import { DEFAULT_WINDOWS_AGENT_OPTIONS, resolveWindowsAgentOptions } from './windowsAgentConfig';

describe('resolveWindowsAgentOptions', () => {
  it('defaults to the real agent: task AzitoAgent, folder .azito\\agent, port 3002', () => {
    expect(resolveWindowsAgentOptions({})).toEqual({ taskName: 'AzitoAgent', dir: '.azito\\agent', port: 3002 });
    expect(resolveWindowsAgentOptions({ AZITO_WIN_AGENT_TASK_NAME: '', AZITO_WIN_AGENT_DIR: '', AZITO_WIN_AGENT_PORT: '' })).toEqual(DEFAULT_WINDOWS_AGENT_OPTIONS);
  });

  it('takes a task name, a folder (either separator) and a port, for an agent tried out beside the real one', () => {
    expect(resolveWindowsAgentOptions({ AZITO_WIN_AGENT_TASK_NAME: 'w806-AzitoAgent', AZITO_WIN_AGENT_DIR: 'w806/agent', AZITO_WIN_AGENT_PORT: '3902' }))
      .toEqual({ taskName: 'w806-AzitoAgent', dir: 'w806\\agent', port: 3902 });
  });

  it.each([
    [{ AZITO_WIN_AGENT_TASK_NAME: 'bad name' }, /AZITO_WIN_AGENT_TASK_NAME/],
    [{ AZITO_WIN_AGENT_TASK_NAME: '-x' }, /AZITO_WIN_AGENT_TASK_NAME/],
    [{ AZITO_WIN_AGENT_DIR: '..\\x' }, /AZITO_WIN_AGENT_DIR/],
    [{ AZITO_WIN_AGENT_DIR: 'C:\\x' }, /AZITO_WIN_AGENT_DIR/],
    [{ AZITO_WIN_AGENT_DIR: 'a b' }, /AZITO_WIN_AGENT_DIR/],
    [{ AZITO_WIN_AGENT_DIR: '%TEMP%' }, /AZITO_WIN_AGENT_DIR/],
    [{ AZITO_WIN_AGENT_PORT: '80' }, /AZITO_WIN_AGENT_PORT/],
    [{ AZITO_WIN_AGENT_PORT: 'abc' }, /AZITO_WIN_AGENT_PORT/],
  ])('refuses %j instead of replacing it with a default', (env, message) => {
    expect(() => resolveWindowsAgentOptions(env)).toThrow(message);
  });
});
