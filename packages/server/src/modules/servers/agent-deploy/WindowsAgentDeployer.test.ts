import { describe, expect, it } from 'vitest';
import { DEFAULT_WINDOWS_AGENT_OPTIONS } from './windowsAgentConfig';
import { buildAgentEnvFile, powershellErrorText, windowsAgentLayout } from './WindowsAgentDeployer';

describe('windowsAgentLayout', () => {
  it('puts everything under <home>\\<dir>, and gives the SFTP path relative to the home with forward slashes', () => {
    const l = windowsAgentLayout('C:\\Users\\Server User', DEFAULT_WINDOWS_AGENT_OPTIONS, 'abc123');
    expect(l.root).toBe('C:\\Users\\Server User\\.azito\\agent');
    expect(l.rootRelative).toBe('.azito/agent');
    expect(l.entry).toBe('C:\\Users\\Server User\\.azito\\agent\\abc123\\azito-agent.cjs');
    expect(l.envFile).toBe('C:\\Users\\Server User\\.azito\\agent\\agent.env');
    expect(l.taskXml).toBe('C:\\Users\\Server User\\.azito\\agent\\AzitoAgent.task.xml');
  });

  it('refuses a version that is not a plain name', () => {
    expect(() => windowsAgentLayout('C:\\u', DEFAULT_WINDOWS_AGENT_OPTIONS, '..\\x')).toThrow(/Unsafe agent version/);
  });
});

describe('buildAgentEnvFile', () => {
  it('writes the values node --env-file reads', () => {
    expect(buildAgentEnvFile({ token: 'tok', bindAddress: '100.64.0.9', port: 3002, logFile: 'C:\\Users\\a b\\agent.log' }))
      .toBe('AZITO_AGENT_TOKEN=tok\nAZITO_AGENT_BIND=100.64.0.9\nPORT=3002\nAZITO_AGENT_LOG_FILE=C:\\Users\\a b\\agent.log\n');
  });

  it.each(['a\nb', 'a"b', "a'b", 'a#b', ''])('refuses a value that would end or change a dotenv line (%j)', (token) => {
    expect(() => buildAgentEnvFile({ token, bindAddress: '100.64.0.9', port: 3002, logFile: 'C:\\a.log' })).toThrow(/AZITO_AGENT_TOKEN/);
  });
});

describe('powershellErrorText', () => {
  it('passes plain stderr through', () => {
    expect(powershellErrorText(' boom \n')).toBe('boom');
  });

  it('takes the message out of CLIXML', () => {
    const clixml = '#< CLIXML\r\n<Objs Version="1.1.0.1"><S S="Error">tar failed: a &lt;b&gt;_x000D__x000A_</S><S S="Error">at line 3_x000D__x000A_</S></Objs>';
    expect(powershellErrorText(clixml)).toBe('tar failed: a <b>\nat line 3');
  });
});
