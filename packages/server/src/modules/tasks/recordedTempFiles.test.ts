import { describe, it, expect } from 'vitest';
import type { ExecutionLog } from './ExecutionLog';
import { recordedTempFilePaths, recordedSignalFilePath } from './recordedTempFiles';

describe('recordedSignalFilePath', () => {
  it('accepts an absolute path with the task\'s signal prefix and nothing else', () => {
    expect(recordedSignalFilePath('/t/azito-pipe-7-sig-1.log', 7)).toBe('/t/azito-pipe-7-sig-1.log');
    expect(recordedSignalFilePath('/t/azito-pipe-7-1.log', 7)).toBeNull();
    expect(recordedSignalFilePath('/t/azito-pipe-70-sig-1.log', 7)).toBeNull();
    expect(recordedSignalFilePath('azito-pipe-7-sig-1.log', 7)).toBeNull();
    expect(recordedSignalFilePath('/etc/passwd', 7)).toBeNull();
    expect(recordedSignalFilePath(undefined, 7)).toBeNull();
  });
});

function log(type: ExecutionLog['type'], content: unknown, id = 1): ExecutionLog {
  return { id, taskId: 7, unitId: 1, type, content: typeof content === 'string' ? content : JSON.stringify(content), createdAt: '' };
}

describe('recordedTempFilePaths', () => {
  it('collects the paths phase prompts, follow-ups and pipe starts recorded', () => {
    const paths = recordedTempFilePaths([
      log('command', { type: 'phase_prompt', phase: 'planning', outputFilePath: '/t/azito-output-7-a.md', signalFilePath: '/t/azito-pipe-7-sig-1.log', rulesFilePath: '/t/azito-rules-7-a.md' }),
      log('command', { type: 'follow_up_prompt', outputFilePath: '/t/azito-output-7-b.md', signalFilePath: '/t/azito-pipe-7-sig-2.log' }),
      log('command', { type: 'wait_start_pipe', filePath: '/t/azito-pipe-7-99.log', signalFilePath: '/t/azito-pipe-7-sig-1.log' }),
    ], 7);
    expect(paths.sort()).toEqual([
      '/t/azito-output-7-a.md', '/t/azito-output-7-b.md', '/t/azito-pipe-7-99.log',
      '/t/azito-pipe-7-sig-1.log', '/t/azito-pipe-7-sig-2.log', '/t/azito-rules-7-a.md',
    ]);
  });

  it('ignores paths that are not this task\'s temp files, relative paths and non-recording logs', () => {
    expect(recordedTempFilePaths([
      log('command', { type: 'phase_prompt', outputFilePath: '/etc/passwd', signalFilePath: '/t/azito-pipe-70-sig-1.log', rulesFilePath: 'azito-rules-7-x.md' }),
      log('command', { type: 'other', outputFilePath: '/t/azito-output-7-z.md' }),
      log('output', { type: 'phase_prompt', outputFilePath: '/t/azito-output-7-z.md' }),
      log('command', 'not json'),
      log('command', '123'),
    ], 7)).toEqual([]);
  });

  it('returns nothing for logs written before paths were recorded', () => {
    expect(recordedTempFilePaths([log('command', { type: 'phase_prompt', phase: 'planning', doneMarker: 'AZITO_DONE_7_x' })], 7)).toEqual([]);
  });
});
