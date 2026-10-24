import { describe, expect, it } from 'vitest';
import { parseAgentHostInfo } from './agentHostProtocol';

describe('parseAgentHostInfo', () => {
  it('reads the answer of an agent from before homeDir / tmpDir were reported (also what the misao pane shell asks for)', () => {
    expect(parseAgentHostInfo({ platform: 'linux', arch: 'x64', shell: '/bin/bash' })).toEqual({ platform: 'linux', arch: 'x64', shell: '/bin/bash' });
  });

  it('reads the temp and home folders when they are reported', () => {
    expect(parseAgentHostInfo({ platform: 'win32', arch: 'x64', shell: null, homeDir: 'C:\\Users\\u', tmpDir: 'C:\\Temp' })).toMatchObject({ homeDir: 'C:\\Users\\u', tmpDir: 'C:\\Temp' });
  });

  it('still refuses a wrong type or an empty folder', () => {
    expect(() => parseAgentHostInfo({ platform: 'linux', arch: 'x64', shell: null, tmpDir: 5 })).toThrow();
    expect(() => parseAgentHostInfo({ platform: 'linux', arch: 'x64', shell: null, tmpDir: '' })).toThrow();
  });
});
