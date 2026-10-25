import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { UpdateStateManager, currentRunLines } from '../UpdateStateManager';
import { createSecretFileGuard } from '../../../shared/os/secretFileGuard';

describe('currentRunLines', () => {
  it('starts at the last "Update started" line', () => {
    const lines = [
      '[t1] Update started: v1 -> v2',
      '[t2] old failure',
      '[t3] Update started: v1 -> v2',
      '[t4] new failure',
    ];
    expect(currentRunLines(lines)).toEqual(['[t3] Update started: v1 -> v2', '[t4] new failure']);
  });

  it('returns every line when no run start is recorded', () => {
    expect(currentRunLines(['[t1] a', '[t2] b'])).toEqual(['[t1] a', '[t2] b']);
  });
});

describe('UpdateStateManager.readLog', () => {
  let dir: string;
  let manager: UpdateStateManager;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-state-'));
    manager = new UpdateStateManager(
      path.join(dir, 'state.json'),
      path.join(dir, 'update.log'),
      createSecretFileGuard(process.platform, process.env),
    );
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('shows only the current run, so an earlier run does not hide its failure line', () => {
    manager.appendLog('Update started: v1 -> v2');
    manager.appendLog('first run line');
    manager.appendLog('Update started: v1 -> v2');
    manager.appendLog('second run failure');
    const log = manager.readLog();
    expect(log).toHaveLength(2);
    expect(log[0]).toContain('Update started');
    expect(log[1]).toContain('second run failure');
  });

  it('keeps the tail of a long current run', () => {
    manager.appendLog('Update started: v1 -> v2');
    for (let i = 0; i < 5; i++) manager.appendLog(`line ${i}`);
    const log = manager.readLog(2);
    expect(log.map((l) => l.replace(/^\[[^\]]*\] /, ''))).toEqual(['line 3', 'line 4']);
  });
});
