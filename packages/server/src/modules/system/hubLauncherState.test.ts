import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { describeHubLauncherState, readHubLauncherState } from './hubLauncherState';

describe('hub launcher state', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azls-'));
    file = path.join(dir, 'hub-launcher.json');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('is undefined when the launcher has not written one', () => {
    expect(readHubLauncherState(file)).toBeUndefined();
  });

  it('reads what the launcher writes (ConvertTo-Json -Compress, with or without a BOM)', () => {
    const json = '{"startedAt":"2026-10-25T01:00:00.0000000Z","restarts":2,"lastExitCode":-1,"lastExitAt":"2026-10-25T01:05:00.0000000Z","nextWaitSeconds":10}';
    fs.writeFileSync(file, `﻿${json}`);
    expect(readHubLauncherState(file)).toEqual({ startedAt: '2026-10-25T01:00:00.0000000Z', restarts: 2, lastExitCode: -1, lastExitAt: '2026-10-25T01:05:00.0000000Z', nextWaitSeconds: 10 });
  });

  it('is an error, not "no restarts", when the file is not what the launcher writes', () => {
    fs.writeFileSync(file, '{"restarts":"many"}');
    expect(() => readHubLauncherState(file)).toThrow();
    fs.writeFileSync(file, 'not json');
    expect(() => readHubLauncherState(file)).toThrow();
  });

  it('describes no restart, a restart after an exit code, and a restart where no hub could be started', () => {
    const base = { startedAt: 'T0', nextWaitSeconds: 5 };
    expect(describeHubLauncherState({ ...base, restarts: 0, lastExitCode: null, lastExitAt: null })).toMatch(/no restart since the launcher began \(T0\)/);
    expect(describeHubLauncherState({ ...base, restarts: 1, lastExitCode: 1, lastExitAt: 'T1' })).toBe('1 restart since T0 (last exit code 1, at T1)');
    expect(describeHubLauncherState({ ...base, restarts: 3, lastExitCode: null, lastExitAt: 'T2' })).toBe('3 restarts since T0 (the launcher could not start it, at T2)');
  });
});
