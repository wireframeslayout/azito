import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { TranscriptService } from './TranscriptService';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-test-'));
}

function writeSession(projectsDir: string, projectName: string, sessionId: string, lines: unknown[]): string {
  const projectDir = path.join(projectsDir, projectName);
  fs.mkdirSync(projectDir, { recursive: true });
  const file = path.join(projectDir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

const SID_A = '11111111-1111-1111-1111-111111111111';
const SID_B = '22222222-2222-2222-2222-222222222222';

describe('TranscriptService', () => {
  let dir: string;
  let service: TranscriptService;

  beforeEach(() => {
    dir = tmpDir();
    service = new TranscriptService(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('listSessions', () => {
    it('returns empty list when projects dir does not exist', () => {
      const svc = new TranscriptService(path.join(dir, 'nonexistent'));
      expect(svc.listSessions()).toEqual([]);
    });

    it('lists sessions ordered by mtime descending and excludes subagents/ subdir', () => {
      const fileA = writeSession(dir, 'proj-a', SID_A, [
        { type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'Hello world, this is the first message' } },
      ]);
      const fileB = writeSession(dir, 'proj-b', SID_B, [
        { type: 'user', uuid: 'u2', timestamp: '2026-01-02T00:00:00Z', message: { role: 'user', content: 'Second session start' } },
      ]);
      // A file nested under subagents/ must not be picked up (maxdepth 1 only).
      const subDir = path.join(dir, 'proj-a', 'subagents');
      fs.mkdirSync(subDir, { recursive: true });
      fs.writeFileSync(path.join(subDir, '33333333-3333-3333-3333-333333333333.jsonl'), JSON.stringify({ type: 'user', uuid: 'x', message: { content: 'nested' } }) + '\n');

      const now = Date.now() / 1000;
      fs.utimesSync(fileA, now, now - 100);
      fs.utimesSync(fileB, now, now);

      const sessions = service.listSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions[0].sessionId).toBe(SID_B);
      expect(sessions[1].sessionId).toBe(SID_A);
      expect(sessions[0].preview).toBe('Second session start');
      expect(sessions[0].projectDir).toBe('proj-b');
    });

    it('respects the limit parameter', () => {
      writeSession(dir, 'proj-a', SID_A, [{ type: 'user', uuid: 'u1', message: { content: 'a' } }]);
      writeSession(dir, 'proj-b', SID_B, [{ type: 'user', uuid: 'u2', message: { content: 'b' } }]);
      expect(service.listSessions(1)).toHaveLength(1);
    });

    it('extracts preview from the first array-content text block', () => {
      writeSession(dir, 'proj-a', SID_A, [
        { type: 'system', uuid: 's0', message: { content: 'meta stuff' } },
        {
          type: 'user',
          uuid: 'u1',
          message: {
            content: [
              { type: 'thinking', thinking: 'not a preview' },
              { type: 'text', text: 'This is the actual preview text that should be truncated eventually if too long' },
            ],
          },
        },
      ]);
      const sessions = service.listSessions();
      expect(sessions[0].preview.startsWith('This is the actual preview')).toBe(true);
      expect(sessions[0].preview.length).toBeLessThanOrEqual(120);
    });
  });

  describe('readSession', () => {
    it('rejects non-UUID session ids', () => {
      expect(service.readSession('not-a-uuid')).toBeNull();
      expect(service.readSession('../../etc/passwd')).toBeNull();
    });

    it('returns null when session file does not exist', () => {
      expect(service.readSession(SID_A)).toBeNull();
    });

    it('initial read returns only the last 500 entries, truncated, nextOffset at EOF', () => {
      const lines: unknown[] = [];
      for (let i = 0; i < 600; i++) {
        lines.push({ type: 'user', uuid: `u${i}`, timestamp: null, message: { content: `message ${i}` } });
      }
      const file = writeSession(dir, 'proj-a', SID_A, lines);
      const result = service.readSession(SID_A);
      expect(result).not.toBeNull();
      expect(result!.entries).toHaveLength(500);
      expect(result!.entries[0].blocks[0]).toEqual({ kind: 'text', text: 'message 100' });
      expect(result!.entries[499].blocks[0]).toEqual({ kind: 'text', text: 'message 599' });
      expect(result!.truncated).toBe(true);
      expect(result!.nextOffset).toBe(fs.statSync(file).size);
    });

    it('offset-based read returns only newly appended, complete lines and carries over the incomplete tail', () => {
      const file = writeSession(dir, 'proj-a', SID_A, [
        { type: 'user', uuid: 'u1', message: { content: 'first' } },
      ]);
      const first = service.readSession(SID_A);
      expect(first!.entries).toHaveLength(1);
      const offsetAfterFirst = first!.nextOffset;

      // Append a complete line followed by a partial (unterminated) line.
      const completeLine = JSON.stringify({ type: 'user', uuid: 'u2', message: { content: 'second' } });
      const partialLine = JSON.stringify({ type: 'user', uuid: 'u3', message: { content: 'third' } }).slice(0, 10);
      fs.appendFileSync(file, completeLine + '\n' + partialLine);

      const second = service.readSession(SID_A, offsetAfterFirst);
      expect(second).not.toBeNull();
      expect(second!.entries).toHaveLength(1);
      expect(second!.entries[0].blocks[0]).toEqual({ kind: 'text', text: 'second' });
      expect(second!.truncated).toBe(false);
      // nextOffset should point right after the complete line's newline, not consuming the partial tail.
      expect(second!.nextOffset).toBe(offsetAfterFirst + Buffer.byteLength(completeLine + '\n'));

      // Completing the partial line and reading again from the same nextOffset should now surface it.
      const rest = JSON.stringify({ type: 'user', uuid: 'u3', message: { content: 'third' } }).slice(10) + '\n';
      fs.appendFileSync(file, rest);
      const third = service.readSession(SID_A, second!.nextOffset);
      expect(third!.entries).toHaveLength(1);
      expect(third!.entries[0].blocks[0]).toEqual({ kind: 'text', text: 'third' });
    });

    it('skips malformed lines, isSidechain entries, summary entries, and meta lines without message', () => {
      const lines = [
        'not valid json{{{',
        { type: 'meta', mode: 'x', sessionId: SID_A },
        { type: 'summary', uuid: 'sum1', summary: 'ignored' },
        { type: 'user', uuid: 'sc1', isSidechain: true, message: { content: 'hidden sidechain' } },
        { type: 'user', uuid: 'u1', message: { content: 'visible message' } },
      ];
      writeSession(dir, 'proj-a', SID_A, lines);
      const result = service.readSession(SID_A);
      expect(result!.entries).toHaveLength(1);
      expect(result!.entries[0].uuid).toBe('u1');
    });

    it('handles both string and block-array content shapes for a user/assistant message', () => {
      writeSession(dir, 'proj-a', SID_A, [
        { type: 'user', uuid: 'u1', message: { content: 'plain string content' } },
        {
          type: 'assistant',
          uuid: 'a1',
          message: {
            content: [
              { type: 'text', text: 'assistant reply' },
              { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
            ],
          },
        },
      ]);
      const result = service.readSession(SID_A);
      expect(result!.entries).toHaveLength(2);
      expect(result!.entries[0].blocks).toEqual([{ kind: 'text', text: 'plain string content' }]);
      expect(result!.entries[1].blocks[0]).toEqual({ kind: 'text', text: 'assistant reply' });
      expect(result!.entries[1].blocks[1]).toMatchObject({ kind: 'tool_use', name: 'Bash' });
    });

    it('truncates long tool_use input and long tool_result text with a truncated flag', () => {
      const longArg = 'x'.repeat(3000);
      const longResult = 'y'.repeat(5000);
      writeSession(dir, 'proj-a', SID_A, [
        {
          type: 'assistant',
          uuid: 'a1',
          message: { content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { content: longArg } }] },
        },
        {
          type: 'user',
          uuid: 'u1',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 't1', content: longResult, is_error: false }],
          },
        },
      ]);
      const result = service.readSession(SID_A);
      const toolUseBlock = result!.entries[0].blocks[0];
      const toolResultBlock = result!.entries[1].blocks[0];
      expect(toolUseBlock).toMatchObject({ kind: 'tool_use', truncated: true });
      if (toolUseBlock.kind === 'tool_use') expect(toolUseBlock.input.length).toBe(2000);
      expect(toolResultBlock).toMatchObject({ kind: 'tool_result', truncated: true, isError: false });
      if (toolResultBlock.kind === 'tool_result') expect(toolResultBlock.text.length).toBe(4000);
    });

    it('drops entries whose blocks end up empty (e.g. only unrecognized block types)', () => {
      writeSession(dir, 'proj-a', SID_A, [
        { type: 'user', uuid: 'u1', message: { content: [{ type: 'unknown_block', foo: 'bar' }] } },
        { type: 'user', uuid: 'u2', message: { content: 'kept' } },
      ]);
      const result = service.readSession(SID_A);
      expect(result!.entries).toHaveLength(1);
      expect(result!.entries[0].uuid).toBe('u2');
    });
  });
});
