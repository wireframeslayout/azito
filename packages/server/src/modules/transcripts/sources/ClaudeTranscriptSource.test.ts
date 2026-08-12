import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ClaudeTranscriptSource } from './ClaudeTranscriptSource';

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

describe('ClaudeTranscriptSource', () => {
  let dir: string;
  let service: ClaudeTranscriptSource;

  beforeEach(() => {
    dir = tmpDir();
    service = new ClaudeTranscriptSource(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('listSessions', () => {
    it('returns empty list when projects dir does not exist', () => {
      const svc = new ClaudeTranscriptSource(path.join(dir, 'nonexistent'));
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

    it('builds preview from only the first previewScanBytes of the file, ignoring later huge content', () => {
      const smallScanService = new ClaudeTranscriptSource(dir, { previewScanBytes: 200 });
      const firstLine = JSON.stringify({
        type: 'user',
        uuid: 'u1',
        message: { content: 'Head text that is within the scan window' },
      });
      // A giant line appended after the first one must not be read at all (would be slow/huge for a real fixture).
      const hugeLine = JSON.stringify({
        type: 'user',
        uuid: 'u2',
        message: { content: 'z'.repeat(1_000_000) },
      });
      const file = path.join(dir, 'proj-a');
      fs.mkdirSync(file, { recursive: true });
      fs.writeFileSync(path.join(file, `${SID_A}.jsonl`), `${firstLine}\n${hugeLine}\n`);

      const sessions = smallScanService.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].preview).toBe('Head text that is within the scan window');
    });

    it('extracts cwd from a JSONL line and exposes it on SessionSummary', () => {
      writeSession(dir, 'proj-a', SID_A, [
        { type: 'user', uuid: 'u1', cwd: '/home/server01/workspace/azito-wt-transcript', message: { content: 'Hello' } },
      ]);
      const sessions = service.listSessions();
      expect(sessions[0].cwd).toBe('/home/server01/workspace/azito-wt-transcript');
    });

    it('returns cwd null when no line carries a cwd field', () => {
      writeSession(dir, 'proj-a', SID_A, [{ type: 'user', uuid: 'u1', message: { content: 'Hello' } }]);
      const sessions = service.listSessions();
      expect(sessions[0].cwd).toBeNull();
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

  describe('getSessionCwd', () => {
    it('returns null for a non-UUID or nonexistent session', () => {
      expect(service.getSessionCwd('not-a-uuid')).toBeNull();
      expect(service.getSessionCwd(SID_A)).toBeNull();
    });

    it('returns the cwd found in the JSONL when present', () => {
      writeSession(dir, 'proj-a', SID_A, [
        { type: 'user', uuid: 'u1', cwd: '/home/server01/workspace/azito-wt-transcript', message: { content: 'Hello' } },
      ]);
      expect(service.getSessionCwd(SID_A)).toEqual({ cwd: '/home/server01/workspace/azito-wt-transcript' });
    });

    it('returns { cwd: null } when the session exists but no line carries cwd', () => {
      writeSession(dir, 'proj-a', SID_A, [{ type: 'user', uuid: 'u1', message: { content: 'Hello' } }]);
      expect(service.getSessionCwd(SID_A)).toEqual({ cwd: null });
    });
  });

  describe('getSessionCreatedMs', () => {
    it('returns null for a non-UUID or nonexistent session', () => {
      expect(service.getSessionCreatedMs('not-a-uuid')).toBeNull();
      expect(service.getSessionCreatedMs(SID_A)).toBeNull();
    });

    it('returns the file birthtime when the filesystem supports it', () => {
      const file = writeSession(dir, 'proj-a', SID_A, [{ type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:00Z', message: { content: 'Hello' } }]);
      const birthtimeMs = fs.statSync(file).birthtimeMs;
      if (birthtimeMs <= 0) return; // filesystem doesn't support birthtime — covered by the fallback test below
      expect(service.getSessionCreatedMs(SID_A)).toBe(birthtimeMs);
    });

    it('falls back to the first line timestamp when birthtime is unavailable (e.g. unsupported filesystem)', () => {
      const file = writeSession(dir, 'proj-a', SID_A, [{ type: 'user', uuid: 'u1', timestamp: '2026-01-05T10:20:30.000Z', message: { content: 'Hello' } }]);
      const realStatSync = fs.statSync;
      const statSpy = vi.spyOn(fs, 'statSync').mockImplementation((p, opts) => {
        const stat = (realStatSync as (p: fs.PathLike, opts?: unknown) => fs.Stats)(p, opts);
        if (p === file) Object.defineProperty(stat, 'birthtimeMs', { value: 0 });
        return stat;
      });
      try {
        expect(service.getSessionCreatedMs(SID_A)).toBe(Date.parse('2026-01-05T10:20:30.000Z'));
      } finally {
        statSpy.mockRestore();
      }
    });

    it('returns null when birthtime is unavailable and no line carries a timestamp', () => {
      const file = writeSession(dir, 'proj-a', SID_A, [{ type: 'user', uuid: 'u1', message: { content: 'Hello' } }]);
      const realStatSync = fs.statSync;
      const statSpy = vi.spyOn(fs, 'statSync').mockImplementation((p, opts) => {
        const stat = (realStatSync as (p: fs.PathLike, opts?: unknown) => fs.Stats)(p, opts);
        if (p === file) Object.defineProperty(stat, 'birthtimeMs', { value: 0 });
        return stat;
      });
      try {
        expect(service.getSessionCreatedMs(SID_A)).toBeNull();
      } finally {
        statSpy.mockRestore();
      }
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

    it('initial read carries over an incomplete trailing line, kept for the next read', () => {
      const file = writeSession(dir, 'proj-a', SID_A, [{ type: 'user', uuid: 'u1', message: { content: 'first' } }]);
      // Append a complete line followed by a partial (unterminated) line, simulating a write in progress.
      const completeLine = JSON.stringify({ type: 'user', uuid: 'u2', message: { content: 'second' } });
      const partialLine = JSON.stringify({ type: 'user', uuid: 'u3', message: { content: 'third' } }).slice(0, 10);
      fs.appendFileSync(file, completeLine + '\n' + partialLine);

      const result = service.readSession(SID_A);
      expect(result).not.toBeNull();
      expect(result!.entries).toHaveLength(2);
      expect(result!.entries[0].uuid).toBe('u1');
      expect(result!.entries[1].uuid).toBe('u2');
      // nextOffset must stop right after the complete line's newline, not consuming the partial tail.
      const expectedOffset = Buffer.byteLength(
        [JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'first' } }), completeLine].join('\n') + '\n',
      );
      expect(result!.nextOffset).toBe(expectedOffset);

      // Completing the partial line and reading again from the same nextOffset should now surface it.
      const rest = JSON.stringify({ type: 'user', uuid: 'u3', message: { content: 'third' } }).slice(10) + '\n';
      fs.appendFileSync(file, rest);
      const follow = service.readSession(SID_A, result!.nextOffset);
      expect(follow!.entries).toHaveLength(1);
      expect(follow!.entries[0].uuid).toBe('u3');
    });

    it('caps the initial read window to initialReadMaxBytes and marks it truncated', () => {
      const smallWindowService = new ClaudeTranscriptSource(dir, { initialReadMaxBytes: 200 });
      const lines: unknown[] = [];
      for (let i = 0; i < 50; i++) {
        lines.push({ type: 'user', uuid: `u${i}`, timestamp: null, message: { content: `message-${i}` } });
      }
      const file = writeSession(dir, 'proj-a', SID_A, lines);
      const fileSize = fs.statSync(file).size;
      expect(fileSize).toBeGreaterThan(200);

      const result = smallWindowService.readSession(SID_A);
      expect(result).not.toBeNull();
      expect(result!.truncated).toBe(true);
      expect(result!.entries.length).toBeGreaterThan(0);
      expect(result!.entries.length).toBeLessThan(50);
      // The earliest entries (u0, u1, ...) fell outside the 200-byte tail window.
      expect(result!.entries[0].uuid).not.toBe('u0');
      // nextOffset should be at EOF since the file ends with a complete trailing newline.
      expect(result!.nextOffset).toBe(fileSize);

      // Reading forward from nextOffset should yield nothing new (no data left).
      const follow = smallWindowService.readSession(SID_A, result!.nextOffset);
      expect(follow!.entries).toHaveLength(0);
    });

    it('caps each incremental read to incrementalReadMaxBytes, requiring multiple polls to drain a large append', () => {
      const smallWindowService = new ClaudeTranscriptSource(dir, { incrementalReadMaxBytes: 200 });
      const file = writeSession(dir, 'proj-a', SID_A, [{ type: 'user', uuid: 'seed', message: { content: 'seed' } }]);
      const first = smallWindowService.readSession(SID_A);
      const startOffset = first!.nextOffset;

      // Append far more than the 200-byte incremental window in one go (simulates a burst of writes
      // between polls). A naive readFromOffset(EOF) would read all of this synchronously in one call.
      const appended: string[] = [];
      for (let i = 0; i < 50; i++) {
        appended.push(JSON.stringify({ type: 'user', uuid: `u${i}`, message: { content: `bulk-${i}` } }));
      }
      fs.appendFileSync(file, appended.join('\n') + '\n');
      const fileSize = fs.statSync(file).size;
      expect(fileSize - startOffset).toBeGreaterThan(200);

      // Drain via repeated polling from nextOffset, as the client does; collect every entry seen.
      const collected: string[] = [];
      let offset = startOffset;
      let iterations = 0;
      while (offset < fileSize && iterations < 100) {
        const result = smallWindowService.readSession(SID_A, offset)!;
        for (const entry of result.entries) {
          if (entry.blocks[0].kind === 'text') collected.push(entry.blocks[0].text);
        }
        expect(result.nextOffset).toBeGreaterThanOrEqual(offset);
        // Each single read call must not have consumed the whole remaining file in one shot;
        // it should have stopped within (or near) the incremental window.
        expect(result.nextOffset - offset).toBeLessThanOrEqual(200 + JSON.stringify({ type: 'user', uuid: 'u0', message: { content: 'bulk-0' } }).length);
        offset = result.nextOffset;
        iterations++;
      }

      expect(iterations).toBeGreaterThan(1); // proves multiple reads were required, i.e. the window was enforced
      expect(offset).toBe(fileSize);
      expect(collected).toEqual(appended.map((_, i) => `bulk-${i}`));
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

    it('falls back to an empty string for a tool_result with missing content, instead of "undefined"', () => {
      writeSession(dir, 'proj-a', SID_A, [
        {
          type: 'user',
          uuid: 'u1',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false }],
          },
        },
      ]);
      const result = service.readSession(SID_A);
      const block = result!.entries[0].blocks[0];
      expect(block).toMatchObject({ kind: 'tool_result', text: '', truncated: false });
    });

    it('reclassifies a user entry whose blocks are tool_result-only as type "tool"', () => {
      writeSession(dir, 'proj-a', SID_A, [
        {
          type: 'user',
          uuid: 'u1',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 't1', content: 'result text', is_error: false }],
          },
        },
      ]);
      const result = service.readSession(SID_A);
      expect(result!.entries).toHaveLength(1);
      expect(result!.entries[0].type).toBe('tool');
    });

    it('keeps type "user" when a user entry mixes tool_result with a text block', () => {
      writeSession(dir, 'proj-a', SID_A, [
        {
          type: 'user',
          uuid: 'u1',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 't1', content: 'result text', is_error: false },
              { type: 'text', text: 'a follow-up prompt' },
            ],
          },
        },
      ]);
      const result = service.readSession(SID_A);
      expect(result!.entries).toHaveLength(1);
      expect(result!.entries[0].type).toBe('user');
    });

    it('keeps type "user" for a plain user text message (no tool_result)', () => {
      writeSession(dir, 'proj-a', SID_A, [
        { type: 'user', uuid: 'u1', message: { content: 'plain human prompt' } },
      ]);
      const result = service.readSession(SID_A);
      expect(result!.entries[0].type).toBe('user');
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

    it('exposes startOffset/hasOlder on the initial read result', () => {
      writeSession(dir, 'proj-a', SID_A, [{ type: 'user', uuid: 'u1', message: { content: 'only entry' } }]);
      const result = service.readSession(SID_A);
      expect(result!.startOffset).toBe(0);
      expect(result!.hasOlder).toBe(false);
    });

    it('converts a "[Request interrupted by user for tool use]" marker into an interrupted entry with empty blocks', () => {
      writeSession(dir, 'proj-a', SID_A, [
        {
          type: 'user',
          uuid: 'u1',
          timestamp: '2026-01-01T00:00:00Z',
          message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] },
        },
      ]);
      const result = service.readSession(SID_A);
      expect(result!.entries).toHaveLength(1);
      expect(result!.entries[0]).toMatchObject({ uuid: 'u1', type: 'interrupted', timestamp: '2026-01-01T00:00:00Z', blocks: [] });
    });

    it('converts the "[Request interrupted by user]" marker variant into an interrupted entry', () => {
      writeSession(dir, 'proj-a', SID_A, [
        { type: 'user', uuid: 'u1', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
      ]);
      const result = service.readSession(SID_A);
      expect(result!.entries[0].type).toBe('interrupted');
    });

    it('does not misclassify a real user message that starts with the marker text but continues in the same block', () => {
      writeSession(dir, 'proj-a', SID_A, [
        { type: 'user', uuid: 'u1', message: { content: [{ type: 'text', text: '[Request interrupted by user] means what?' }] } },
      ]);
      const result = service.readSession(SID_A);
      expect(result!.entries[0].type).toBe('user');
    });

    it('does not misclassify a real user message that merely mentions interruption alongside other text', () => {
      writeSession(dir, 'proj-a', SID_A, [
        {
          type: 'user',
          uuid: 'u1',
          message: {
            content: [
              { type: 'text', text: '[Request interrupted by user for tool use]' },
              { type: 'text', text: 'please continue anyway' },
            ],
          },
        },
      ]);
      const result = service.readSession(SID_A);
      expect(result!.entries[0].type).toBe('user');
    });
  });

  describe('local command entries (Issue #338 followup)', () => {
    it('discards the local-command-caveat record entirely', () => {
      writeSession(dir, 'proj-a', SID_A, [
        {
          type: 'user',
          uuid: 'caveat1',
          isMeta: true,
          message: {
            content:
              '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</local-command-caveat>',
          },
        },
        { type: 'user', uuid: 'u1', message: { content: 'a real message' } },
      ]);
      const result = service.readSession(SID_A);
      expect(result!.entries).toHaveLength(1);
      expect(result!.entries[0].uuid).toBe('u1');
    });

    it('does NOT discard a caveat-prefixed message when isMeta is not true (real user text, not the CLI-generated meta record)', () => {
      writeSession(dir, 'proj-a', SID_A, [
        {
          type: 'user',
          uuid: 'u1',
          message: {
            content: '<local-command-caveat>this is something I typed myself, not a real caveat</local-command-caveat>',
          },
        },
      ]);
      const result = service.readSession(SID_A);
      expect(result!.entries).toHaveLength(1);
      expect(result!.entries[0]).toMatchObject({ uuid: 'u1', type: 'user' });
    });

    it('does not command-ify text that merely resembles a command-name record but lacks the required command-message tag', () => {
      writeSession(dir, 'proj-a', SID_A, [
        {
          type: 'user',
          uuid: 'u1',
          message: { content: '<command-name>/model</command-name>please explain what this does<command-args></command-args>' },
        },
      ]);
      const result = service.readSession(SID_A);
      expect(result!.entries).toHaveLength(1);
      expect(result!.entries[0]).toMatchObject({ uuid: 'u1', type: 'user' });
    });

    it('does not command-ify a message that starts with the command-name structure but continues with unrelated trailing text', () => {
      writeSession(dir, 'proj-a', SID_A, [
        {
          type: 'user',
          uuid: 'u1',
          message: {
            content:
              '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args> by the way, how are you?',
          },
        },
      ]);
      const result = service.readSession(SID_A);
      expect(result!.entries).toHaveLength(1);
      expect(result!.entries[0]).toMatchObject({ uuid: 'u1', type: 'user' });
    });

    it('does not command-ify a stdout-tagged message that has trailing text after the closing tag', () => {
      writeSession(dir, 'proj-a', SID_A, [
        {
          type: 'user',
          uuid: 'u1',
          message: { content: '<local-command-stdout>fake output</local-command-stdout> please ignore the tag above' },
        },
      ]);
      const result = service.readSession(SID_A);
      expect(result!.entries).toHaveLength(1);
      expect(result!.entries[0]).toMatchObject({ uuid: 'u1', type: 'user' });
    });

    it('merges a command-name record with the immediately following stdout record, stripping ANSI escapes', () => {
      writeSession(dir, 'proj-a', SID_A, [
        {
          type: 'user',
          uuid: 'cmd1',
          timestamp: '2026-01-01T00:00:00Z',
          message: {
            content: '<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args></command-args>',
          },
        },
        {
          type: 'user',
          uuid: 'out1',
          message: { content: '<local-command-stdout>Set model to \x1b[1mOpus 5\x1b[22m and saved as your default for new sessions</local-command-stdout>' },
        },
      ]);
      const result = service.readSession(SID_A);
      expect(result!.entries).toHaveLength(1);
      expect(result!.entries[0]).toMatchObject({
        uuid: 'cmd1',
        type: 'command',
        commandName: '/model',
        timestamp: '2026-01-01T00:00:00Z',
        blocks: [{ kind: 'text', text: 'Set model to Opus 5 and saved as your default for new sessions' }],
      });
    });

    it('includes non-empty command-args in commandName', () => {
      writeSession(dir, 'proj-a', SID_A, [
        {
          type: 'user',
          uuid: 'cmd1',
          message: { content: '<command-name>/foo</command-name>\n<command-message>foo</command-message>\n<command-args>bar baz</command-args>' },
        },
      ]);
      const result = service.readSession(SID_A);
      expect(result!.entries[0].commandName).toBe('/foo bar baz');
    });

    it('renders a standalone stdout record (no preceding command-name) as a command entry without commandName', () => {
      writeSession(dir, 'proj-a', SID_A, [
        { type: 'user', uuid: 'out1', message: { content: '<local-command-stdout>some output</local-command-stdout>' } },
      ]);
      const result = service.readSession(SID_A);
      expect(result!.entries).toHaveLength(1);
      expect(result!.entries[0].type).toBe('command');
      expect(result!.entries[0].commandName).toBeUndefined();
      expect(result!.entries[0].blocks).toEqual([{ kind: 'text', text: 'some output' }]);
    });

    it('does not merge a stdout record into a command-name entry that is not immediately adjacent', () => {
      writeSession(dir, 'proj-a', SID_A, [
        {
          type: 'user',
          uuid: 'cmd1',
          message: { content: '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>' },
        },
        { type: 'user', uuid: 'unrelated', message: { content: 'an unrelated message' } },
        { type: 'user', uuid: 'out1', message: { content: '<local-command-stdout>late output</local-command-stdout>' } },
      ]);
      const result = service.readSession(SID_A);
      expect(result!.entries).toHaveLength(3);
      expect(result!.entries[0]).toMatchObject({ uuid: 'cmd1', type: 'command', commandName: '/model', blocks: [] });
      expect(result!.entries[1]).toMatchObject({ uuid: 'unrelated', type: 'user' });
      expect(result!.entries[2]).toMatchObject({ uuid: 'out1', type: 'command', blocks: [{ kind: 'text', text: 'late output' }] });
      expect(result!.entries[2].commandName).toBeUndefined();
    });
  });

  describe('assistant model (Issue #338 followup)', () => {
    it('exposes message.model on assistant entries', () => {
      writeSession(dir, 'proj-a', SID_A, [
        { type: 'assistant', uuid: 'a1', message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'hi' }] } },
      ]);
      const result = service.readSession(SID_A);
      expect(result!.entries[0].model).toBe('claude-opus-5');
    });

    it('leaves model undefined when message.model is absent', () => {
      writeSession(dir, 'proj-a', SID_A, [
        { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'hi' }] } },
      ]);
      const result = service.readSession(SID_A);
      expect(result!.entries[0].model).toBeUndefined();
    });
  });

  describe('AskUserQuestion interaction (Issue #338 phase A)', () => {
    // フィクスチャは一時 claude セッションで実採取した実データの形（tool_use.input / toolUseResult.answers）に基づく。
    const TOOL_USE_ID = 'toolu_017G1yjmjPBsBGNyvwP6ktNR';

    function askUserQuestionToolUse(uuid: string, toolUseId: string, questions: unknown[]) {
      return {
        type: 'assistant',
        uuid,
        message: { content: [{ type: 'tool_use', id: toolUseId, name: 'AskUserQuestion', input: { questions } }] },
      };
    }

    function askUserQuestionToolResult(uuid: string, toolUseId: string, answers: Record<string, string>) {
      return {
        type: 'user',
        uuid,
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolUseId,
              content: 'Your questions have been answered.',
            },
          ],
        },
        toolUseResult: { questions: [], answers, annotations: {} },
      };
    }

    it('emits a single interaction entry (select) at the tool_result position, replacing the raw tool_use/tool_result rows', () => {
      writeSession(dir, 'proj-a', SID_A, [
        askUserQuestionToolUse('a1', TOOL_USE_ID, [
          {
            question: 'お昼ごはんは何にしますか?',
            header: '昼食',
            multiSelect: false,
            options: [
              { label: 'ラーメン', description: '温かい麺類でしっかり満足したい気分の日に' },
              { label: 'サラダ', description: '軽めにヘルシーに済ませたい気分の日に' },
            ],
          },
        ]),
        askUserQuestionToolResult('r1', TOOL_USE_ID, { 'お昼ごはんは何にしますか?': 'ラーメン' }),
      ]);

      const result = service.readSession(SID_A);
      expect(result!.entries).toHaveLength(1);
      expect(result!.entries[0]).toMatchObject({
        uuid: 'r1',
        type: 'interaction',
        blocks: [],
        interaction: {
          kind: 'question',
          source: { origin: 'tool', name: 'AskUserQuestion' },
          fields: [
            {
              id: 'q0',
              label: 'お昼ごはんは何にしますか?',
              input: 'select',
              options: [
                { value: 'ラーメン', label: 'ラーメン', description: '温かい麺類でしっかり満足したい気分の日に' },
                { value: 'サラダ', label: 'サラダ', description: '軽めにヘルシーに済ませたい気分の日に' },
              ],
            },
          ],
          answers: [{ fieldId: 'q0', value: 'ラーメン' }],
        },
      });
    });

    it('infers input: multiselect and keeps the raw comma-joined answer value', () => {
      writeSession(dir, 'proj-a', SID_A, [
        askUserQuestionToolUse('a1', TOOL_USE_ID, [
          {
            question: 'ラーメンのトッピングは何を追加しますか?',
            header: 'トッピング',
            multiSelect: true,
            options: [
              { label: '煮卵', description: '半熟の味付け卵' },
              { label: 'チャーシュー', description: '厚切りの豚肉' },
              { label: 'メンマ', description: 'コリコリした食感の発酵たけのこ' },
            ],
          },
        ]),
        askUserQuestionToolResult('r1', TOOL_USE_ID, { 'ラーメンのトッピングは何を追加しますか?': '煮卵, チャーシュー' }),
      ]);

      const result = service.readSession(SID_A);
      const field = result!.entries[0].interaction!.fields[0];
      expect(field.input).toBe('multiselect');
      expect(result!.entries[0].interaction!.answers).toEqual([
        { fieldId: 'q0', value: '煮卵, チャーシュー' },
      ]);
    });

    it('infers input: text when the answer matches none of the offered option labels (CLI "Type something" free-text answer)', () => {
      writeSession(dir, 'proj-a', SID_A, [
        askUserQuestionToolUse('a1', TOOL_USE_ID, [
          {
            question: 'その人気店の名前は何ですか?',
            header: '店名',
            multiSelect: false,
            options: [
              { label: '未定', description: 'まだ決めていない場合' },
              { label: '定番の店', description: 'いつも行くお気に入りの店' },
            ],
          },
        ]),
        askUserQuestionToolResult('r1', TOOL_USE_ID, { 'その人気店の名前は何ですか?': '麺屋一鶴' }),
      ]);

      const result = service.readSession(SID_A);
      const field = result!.entries[0].interaction!.fields[0];
      expect(field.input).toBe('text');
      expect(result!.entries[0].interaction!.answers).toEqual([{ fieldId: 'q0', value: '麺屋一鶴' }]);
    });

    it('reassembles the interaction when tool_use and tool_result fall in different read windows', () => {
      const smallWindowService = new ClaudeTranscriptSource(dir, { initialReadMaxBytes: 10_000, incrementalReadMaxBytes: 10_000 });
      writeSession(dir, 'proj-a', SID_A, [
        askUserQuestionToolUse('a1', TOOL_USE_ID, [
          { question: 'お昼ごはんは何にしますか?', multiSelect: false, options: [{ label: 'ラーメン' }, { label: 'サラダ' }] },
        ]),
      ]);
      const first = smallWindowService.readSession(SID_A);
      expect(first!.entries).toHaveLength(0); // tool_use のみのブロックは抑制される

      fs.appendFileSync(
        path.join(dir, 'proj-a', `${SID_A}.jsonl`),
        JSON.stringify(askUserQuestionToolResult('r1', TOOL_USE_ID, { 'お昼ごはんは何にしますか?': 'ラーメン' })) + '\n',
      );
      const second = smallWindowService.readSession(SID_A, first!.nextOffset);
      expect(second!.entries).toHaveLength(1);
      expect(second!.entries[0].type).toBe('interaction');
      expect(second!.entries[0].interaction!.answers).toEqual([{ fieldId: 'q0', value: 'ラーメン' }]);
    });

    it('reassembles the interaction via a bounded backward scan when the correlation cache is lost (e.g. server restart) but the tool_use is still within the scan window', () => {
      writeSession(dir, 'proj-a', SID_A, [
        askUserQuestionToolUse('a1', TOOL_USE_ID, [
          { question: 'お昼ごはんは何にしますか?', multiSelect: false, options: [{ label: 'ラーメン' }, { label: 'サラダ' }] },
        ]),
        askUserQuestionToolResult('r1', TOOL_USE_ID, { 'お昼ごはんは何にしますか?': 'ラーメン' }),
      ]);
      // A brand-new instance has an empty askUserQuestionCache, simulating a server restart between the
      // tool_use being written and the tool_result being read (レビュー指摘 Minor 2).
      const freshService = new ClaudeTranscriptSource(dir);
      const result = freshService.readSession(SID_A);
      expect(result!.entries).toHaveLength(1);
      expect(result!.entries[0].type).toBe('interaction');
      expect(result!.entries[0].interaction!.answers).toEqual([{ fieldId: 'q0', value: 'ラーメン' }]);
    });

    it('falls back to a raw tool entry (does not throw) when the correlation cache is lost and no matching tool_use is found within the scan window', () => {
      writeSession(dir, 'proj-a', SID_A, [
        askUserQuestionToolResult('r1', TOOL_USE_ID, { 'お昼ごはんは何にしますか?': 'ラーメン' }),
      ]);
      const freshService = new ClaudeTranscriptSource(dir);
      const result = freshService.readSession(SID_A);
      expect(result!.entries).toHaveLength(1);
      expect(result!.entries[0].type).toBe('tool');
      expect(result!.entries[0].interaction).toBeUndefined();
    });

    it('does not resolve inherited Object.prototype properties (e.g. "constructor") when looking up an answer by question text', () => {
      writeSession(dir, 'proj-a', SID_A, [
        askUserQuestionToolUse('a1', TOOL_USE_ID, [{ question: 'constructor', multiSelect: false, options: [{ label: 'A' }] }]),
        askUserQuestionToolResult('r1', TOOL_USE_ID, { constructor: 'A' }),
      ]);
      const result = service.readSession(SID_A);
      expect(result!.entries).toHaveLength(1);
      expect(result!.entries[0].interaction!.fields[0].input).toBe('select');
      expect(result!.entries[0].interaction!.answers).toEqual([{ fieldId: 'q0', value: 'A' }]);
    });

    it('does not misclassify as answered when the question key only exists as an inherited Object.prototype property, not an own answer', () => {
      writeSession(dir, 'proj-a', SID_A, [
        askUserQuestionToolUse('a1', TOOL_USE_ID, [{ question: 'toString', multiSelect: false, options: [{ label: 'A' }] }]),
        askUserQuestionToolResult('r1', TOOL_USE_ID, {}),
      ]);
      const result = service.readSession(SID_A);
      expect(result!.entries[0].interaction!.fields[0].input).toBe('select');
      expect(result!.entries[0].interaction!.answers).toBeUndefined();
    });

    it('does not convert a rejected AskUserQuestion (toolUseResult is a plain string, not an answers object) into an interaction', () => {
      writeSession(dir, 'proj-a', SID_A, [
        askUserQuestionToolUse('a1', TOOL_USE_ID, [
          { question: 'その人気店の名前は何ですか?', multiSelect: false, options: [{ label: '未定' }, { label: '定番の店' }] },
        ]),
        {
          type: 'user',
          uuid: 'r1',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: TOOL_USE_ID, is_error: true, content: 'The user doesn\'t want to proceed with this tool use.' },
            ],
          },
          toolUseResult: 'User rejected tool use',
        },
      ]);

      const result = service.readSession(SID_A);
      expect(result!.entries).toHaveLength(1);
      expect(result!.entries[0].type).toBe('tool');
      expect(result!.entries[0].interaction).toBeUndefined();
    });

    it('leaves non-AskUserQuestion tool_use/tool_result rows untouched', () => {
      writeSession(dir, 'proj-a', SID_A, [
        { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } },
        { type: 'user', uuid: 'r1', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
      ]);
      const result = service.readSession(SID_A);
      expect(result!.entries.map((e) => e.type)).toEqual(['assistant', 'tool']);
    });
  });

  describe('task-notification formatting (Issue #338 phase A)', () => {
    function taskNotificationContent(summary?: string): string {
      const summaryTag = summary !== undefined ? `<summary>${summary}</summary>\n` : '';
      return `<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n${summaryTag}<result>full report</result>\n</task-notification>`;
    }

    it('formats a full-match <task-notification> record into a system entry carrying the extracted summary', () => {
      writeSession(dir, 'proj-a', SID_A, [
        { type: 'user', uuid: 'u1', message: { content: taskNotificationContent('Agent "Backend exploration" finished') } },
      ]);
      const result = service.readSession(SID_A);
      expect(result!.entries).toHaveLength(1);
      expect(result!.entries[0]).toMatchObject({
        uuid: 'u1',
        type: 'system',
        systemKind: 'task_notification',
        blocks: [{ kind: 'text', text: 'Agent "Backend exploration" finished' }],
      });
    });

    it('uses an empty-string summary block when the <summary> tag is absent', () => {
      writeSession(dir, 'proj-a', SID_A, [
        { type: 'user', uuid: 'u1', message: { content: taskNotificationContent() } },
      ]);
      const result = service.readSession(SID_A);
      expect(result!.entries[0].blocks).toEqual([{ kind: 'text', text: '' }]);
    });

    it('does not format a message that merely starts with the task-notification tag but has trailing text after the closing tag', () => {
      writeSession(dir, 'proj-a', SID_A, [
        { type: 'user', uuid: 'u1', message: { content: `${taskNotificationContent('done')} by the way, thanks!` } },
      ]);
      const result = service.readSession(SID_A);
      expect(result!.entries[0].type).toBe('user');
      expect(result!.entries[0].systemKind).toBeUndefined();
    });

    it('discards a sidechain (subagent-internal) task-notification record instead of surfacing it as a visible system entry', () => {
      writeSession(dir, 'proj-a', SID_A, [
        { type: 'user', uuid: 'sc1', isSidechain: true, message: { content: taskNotificationContent('hidden sidechain notification') } },
        { type: 'user', uuid: 'u1', message: { content: 'visible message' } },
      ]);
      const result = service.readSession(SID_A);
      expect(result!.entries).toHaveLength(1);
      expect(result!.entries[0].uuid).toBe('u1');
    });
  });

  describe('getSessionTailState', () => {
    it('returns unknown for a nonexistent session', async () => {
      expect(await service.getSessionTailState('not-a-uuid')).toBe('unknown');
      expect(await service.getSessionTailState(SID_A)).toBe('unknown');
    });

    it('returns terminal when the last meaningful record is an interrupt marker', async () => {
      writeSession(dir, 'proj-a', SID_A, [
        { type: 'user', uuid: 'u1', message: { content: 'do the thing' } },
        { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } },
        { type: 'user', uuid: 'u2', message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } },
      ]);
      expect(await service.getSessionTailState(SID_A)).toBe('terminal');
    });

    it('returns terminal when the last meaningful record is a local command entry', async () => {
      writeSession(dir, 'proj-a', SID_A, [
        { type: 'user', uuid: 'u1', message: { content: 'hi' } },
        {
          type: 'user',
          uuid: 'cmd1',
          message: { content: '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>' },
        },
        { type: 'user', uuid: 'out1', message: { content: '<local-command-stdout>Set model to Opus 5</local-command-stdout>' } },
      ]);
      expect(await service.getSessionTailState(SID_A)).toBe('terminal');
    });

    it('returns terminal when the last meaningful record is an assistant final text response', async () => {
      writeSession(dir, 'proj-a', SID_A, [
        { type: 'user', uuid: 'u1', message: { content: 'hi' } },
        { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'done' }] } },
      ]);
      expect(await service.getSessionTailState(SID_A)).toBe('terminal');
    });

    it('returns in_progress when the last meaningful record is an assistant entry ending in a thinking block (mid-turn, not a final response)', async () => {
      writeSession(dir, 'proj-a', SID_A, [
        { type: 'user', uuid: 'u1', message: { content: 'hi' } },
        { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'thinking', thinking: 'pondering...' }] } },
      ]);
      expect(await service.getSessionTailState(SID_A)).toBe('in_progress');
    });

    it('returns in_progress when the last meaningful record is a user message', async () => {
      writeSession(dir, 'proj-a', SID_A, [
        { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'done' }] } },
        { type: 'user', uuid: 'u1', message: { content: 'another question' } },
      ]);
      expect(await service.getSessionTailState(SID_A)).toBe('in_progress');
    });

    it('returns in_progress when the last meaningful record is a tool_use', async () => {
      writeSession(dir, 'proj-a', SID_A, [
        { type: 'user', uuid: 'u1', message: { content: 'do it' } },
        { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } },
      ]);
      expect(await service.getSessionTailState(SID_A)).toBe('in_progress');
    });

    it('returns in_progress when the last meaningful record is an interaction (AskUserQuestion answered, agent turn continues)', async () => {
      const toolUseId = 'toolu_017G1yjmjPBsBGNyvwP6ktNR';
      writeSession(dir, 'proj-a', SID_A, [
        {
          type: 'assistant',
          uuid: 'a1',
          message: { content: [{ type: 'tool_use', id: toolUseId, name: 'AskUserQuestion', input: { questions: [{ question: 'Lunch?', options: [{ label: 'Ramen' }] }] } }] },
        },
        {
          type: 'user',
          uuid: 'r1',
          message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'answered' }] },
          toolUseResult: { questions: [], answers: { 'Lunch?': 'Ramen' }, annotations: {} },
        },
      ]);
      expect(await service.getSessionTailState(SID_A)).toBe('in_progress');
    });

    it('returns in_progress when the last meaningful record is a task_notification (background task resumes the agent turn)', async () => {
      writeSession(dir, 'proj-a', SID_A, [
        { type: 'user', uuid: 'u1', message: { content: 'do it' } },
        {
          type: 'user',
          uuid: 'tn1',
          message: { content: '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n<summary>done</summary>\n</task-notification>' },
        },
      ]);
      expect(await service.getSessionTailState(SID_A)).toBe('in_progress');
    });

    it('returns in_progress when the last meaningful record is a tool_result', async () => {
      writeSession(dir, 'proj-a', SID_A, [
        { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } },
        { type: 'user', uuid: 'u1', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
      ]);
      expect(await service.getSessionTailState(SID_A)).toBe('in_progress');
    });

    it('skips malformed/unparseable trailing lines and classifies from the last valid record', async () => {
      const file = writeSession(dir, 'proj-a', SID_A, [
        { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'done' }] } },
      ]);
      fs.appendFileSync(file, 'not json at all\n');
      expect(await service.getSessionTailState(SID_A)).toBe('terminal');
    });
  });

  describe('readSessionBefore', () => {
    it('rejects non-UUID session ids', () => {
      expect(service.readSessionBefore('not-a-uuid', 0)).toBeNull();
    });

    it('returns null when session file does not exist', () => {
      expect(service.readSessionBefore(SID_A, 0)).toBeNull();
    });

    it('drains an entire session backward via repeated before reads with no duplicates', () => {
      const smallWindowService = new ClaudeTranscriptSource(dir, { initialReadMaxBytes: 120, incrementalReadMaxBytes: 120 });
      const lines: unknown[] = [];
      for (let i = 0; i < 30; i++) {
        lines.push({ type: 'user', uuid: `u${i}`, timestamp: null, message: { content: `message ${i}` } });
      }
      writeSession(dir, 'proj-a', SID_A, lines);

      const initial = smallWindowService.readSession(SID_A);
      expect(initial!.hasOlder).toBe(true);

      const collected: string[] = initial!.entries.map((e) => (e.blocks[0].kind === 'text' ? e.blocks[0].text : ''));
      let before = initial!.startOffset;
      let hasOlder = initial!.hasOlder;
      let iterations = 0;
      while (hasOlder && iterations < 100) {
        const page = smallWindowService.readSessionBefore(SID_A, before)!;
        expect(page.prevOffset).toBeLessThan(before);
        collected.unshift(...page.entries.map((e) => (e.blocks[0].kind === 'text' ? e.blocks[0].text : '')));
        before = page.prevOffset;
        hasOlder = page.hasOlder;
        iterations++;
      }

      expect(iterations).toBeGreaterThan(1);
      expect(before).toBe(0);
      expect(collected).toEqual(lines.map((_, i) => `message ${i}`));
    });
  });
});
