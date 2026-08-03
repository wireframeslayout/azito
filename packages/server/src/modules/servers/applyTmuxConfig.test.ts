import { describe, it, expect } from 'vitest';
import { buildApplyTmuxConfigCommands } from './agent-deploy/TmuxInstaller';

describe('buildApplyTmuxConfigCommands', () => {
  it('generates commands using the provided home dir', () => {
    const cmds = buildApplyTmuxConfigCommands('/home/user');
    expect(cmds[0]).toContain('/home/user/.azito/tmux');
    expect(cmds[2]).toContain('source-file /home/user/.azito/tmux/azito.conf');
  });

  it('idempotent: grep -qxF prevents duplicate source-file line', () => {
    const cmds = buildApplyTmuxConfigCommands('$HOME');
    const grepCmd = cmds[2];
    expect(grepCmd).toContain('grep -qxF');
    expect(grepCmd).toContain('|| echo');
  });
});
