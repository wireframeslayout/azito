import { describe, expect, it } from 'vitest';
import { agentTaskAction, agentTaskIdentity, legacyAgentTaskAction } from './windowsAgentTask';
import { joinWindowsArgs } from '../../../shared/os/taskScheduler/windowsCommandLine';

const systemRoot = 'C:\\Windows';
const root = 'C:\\Users\\Test User\\.azito\\agent';
const node = 'C:\\Program Files\\nodejs\\node.exe';
const env = `${root}\\agent.env`;
const entry = `${root}\\123abc\\azito-agent.cjs`;

describe('agent task identity', () => {
  it.each([(s: string, n: string, e: string, p: string) => agentTaskAction(s, n, e, p, 'AzitoAgent'), legacyAgentTaskAction])('recognises the exact generated definition', (build) => {
    const action = build(systemRoot, node, env, entry);
    expect(agentTaskIdentity({ command: action.executable, argumentsLine: joinWindowsArgs(action.args) }, systemRoot, root, env, 'AzitoAgent')?.version).toBe('123abc');
    expect(agentTaskIdentity({ command: action.executable, argumentsLine: `${joinWindowsArgs(action.args)} extra` }, systemRoot, root, env, 'AzitoAgent')).toBeUndefined();
    expect(agentTaskIdentity({ command: action.executable, argumentsLine: joinWindowsArgs(action.args) }, systemRoot, `${root}2`, env, 'AzitoAgent')).toBeUndefined();
  });

  it('recognises paths containing PowerShell quote characters', () => {
    const quotedRoot = "C:\\Users\\O'Neil’s\\.azito\\agent";
    const quotedEnv = `${quotedRoot}\\agent.env`;
    const action = agentTaskAction(systemRoot, node, quotedEnv, `${quotedRoot}\\abc\\azito-agent.cjs`, 'AzitoAgent');
    expect(agentTaskIdentity({ command: action.executable, argumentsLine: joinWindowsArgs(action.args) }, systemRoot, quotedRoot, quotedEnv, 'AzitoAgent')?.version).toBe('abc');
  });
});
