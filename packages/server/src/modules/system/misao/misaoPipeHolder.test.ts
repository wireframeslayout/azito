import { describe, expect, it } from 'vitest';
import { judgeHolder, pipeHolderScript } from './misaoPipeHolder';

const ME = 'S-1-5-21-111-222-333-1001';

describe('judgeHolder (who holds the lock pipe, as Windows says)', () => {
  it('is this user\'s only when Windows names the same owner SID (letter case does not matter)', () => {
    expect(judgeHolder(`pid=4321\r\nowner=${ME}\r\nme=${ME}\r\n`)).toEqual({ state: 'same-user', pid: 4321 });
    expect(judgeHolder(`pid=4321\nowner=${ME.toLowerCase()}\nme=${ME}\n`)).toEqual({ state: 'same-user', pid: 4321 });
  });

  it('is another user\'s when the owner SID differs', () => {
    expect(judgeHolder(`pid=77\nowner=S-1-5-21-111-222-333-1002\nme=${ME}\n`)).toEqual({ state: 'other-user', pid: 77, ownerSid: 'S-1-5-21-111-222-333-1002' });
    expect(judgeHolder(`pid=77\nowner=S-1-5-18\nme=${ME}\n`)).toMatchObject({ state: 'other-user' });
  });

  it('is unknown, never "mine", when the owner cannot be read', () => {
    expect(judgeHolder(`pid=77\nowner=\nme=${ME}\n`)).toEqual({ state: 'unknown', pid: 77, reason: 'the owner of process 77 could not be read' });
    expect(judgeHolder(`pid=77\nme=${ME}\n`)).toMatchObject({ state: 'unknown', pid: 77 });
  });

  it('is unknown when the pid or this user\'s own SID is missing, or the output is not what the script prints', () => {
    expect(judgeHolder(`owner=${ME}\nme=${ME}\n`)).toMatchObject({ state: 'unknown', reason: expect.stringContaining('which process') });
    expect(judgeHolder(`pid=77\nowner=${ME}\nme=\n`)).toMatchObject({ state: 'unknown', pid: 77, reason: expect.stringContaining('SID of this user') });
    expect(judgeHolder('')).toMatchObject({ state: 'unknown' });
    expect(judgeHolder('pid=abc\nowner=x\nme=y\n')).toMatchObject({ state: 'unknown' });
  });
});

describe('pipeHolderScript', () => {
  it('asks Windows for the server of the pipe and the owner of that process, never the pipe itself', () => {
    const script = pipeHolderScript('\\\\.\\pipe\\azito-lock-abc');
    expect(script).toContain('GetNamedPipeServerProcessId');
    expect(script).toContain('GetOwnerSid');
    expect(script).toContain("$name = 'azito-lock-abc'");
  });

  it('refuses a name that is not a named pipe path', () => {
    expect(() => pipeHolderScript('C:\\x')).toThrow(/Not a named pipe path/);
  });
});
