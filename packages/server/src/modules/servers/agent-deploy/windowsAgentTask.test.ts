import { describe, expect, it } from 'vitest';
import { agentTaskAction, agentTaskIdentity, legacyAgentTaskAction } from './windowsAgentTask';
import { joinWindowsArgs } from '../../../shared/os/taskScheduler/windowsCommandLine';

const systemRoot = 'C:\\Windows';
const root = 'C:\\Users\\Test User\\.azito\\agent';
const node = 'C:\\Program Files\\nodejs\\node.exe';
const env = `${root}\\agent.env`;
const entry = `${root}\\123abc\\azito-agent.cjs`;

function differentOs(line: string): string {
  return line.replace(/(-EncodedCommand )([A-Za-z0-9+/=]+)$/, (_all, prefix: string, encoded: string) => {
    const outer = Buffer.from(encoded, 'base64').toString('utf16le');
    const updated = outer.replace(/(\$azitoTaskGzip=')([A-Za-z0-9+/=]+)(')/, (_m, a: string, payload: string, b: string) => {
      const bytes = Buffer.from(payload, 'base64'); bytes[9] = 10; return a + bytes.toString('base64') + b;
    });
    return prefix + Buffer.from(updated, 'utf16le').toString('base64');
  });
}

describe('agent task identity', () => {
  it.each([(s: string, n: string, e: string, p: string) => agentTaskAction(s, n, e, p, 'AzitoAgent'), legacyAgentTaskAction])('recognises the exact generated definition', (build) => {
    const action = build(systemRoot, node, env, entry);
    expect(agentTaskIdentity({ command: action.executable, argumentsLine: joinWindowsArgs(action.args) }, systemRoot, root, env, 'AzitoAgent')?.version).toBe('123abc');
    expect(agentTaskIdentity({ command: action.executable, argumentsLine: `${joinWindowsArgs(action.args)} extra` }, systemRoot, root, env, 'AzitoAgent')).toBeUndefined();
    expect(agentTaskIdentity({ command: action.executable, argumentsLine: joinWindowsArgs(action.args) }, systemRoot, `${root}2`, env, 'AzitoAgent')).toBeUndefined();
  });

  it('recognises the task written by a hub with another gzip OS byte', () => {
    const action = agentTaskAction(systemRoot, node, env, entry, 'AzitoAgent');
    expect(agentTaskIdentity({ command: action.executable, argumentsLine: differentOs(joinWindowsArgs(action.args)) }, systemRoot, root, env, 'AzitoAgent')?.version).toBe('123abc');
  });

  it('recognises paths containing PowerShell quote characters', () => {
    const quotedRoot = "C:\\Users\\O'Neil’s\\.azito\\agent";
    const quotedEnv = `${quotedRoot}\\agent.env`;
    const action = agentTaskAction(systemRoot, node, quotedEnv, `${quotedRoot}\\abc\\azito-agent.cjs`, 'AzitoAgent');
    expect(agentTaskIdentity({ command: action.executable, argumentsLine: joinWindowsArgs(action.args) }, systemRoot, quotedRoot, quotedEnv, 'AzitoAgent')?.version).toBe('abc');
  });
});
