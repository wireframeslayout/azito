import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { CodexTranscriptSource } from './CodexTranscriptSource';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-transcript-test-'));
}

/** sessions/YYYY/MM/DD/rollout-<ts>-<sessionId>.jsonl を書く（実データと同じ命名規則）。 */
function writeSession(sessionsDir: string, sessionId: string, lines: unknown[]): string {
  const dayDir = path.join(sessionsDir, '2026', '05', '31');
  fs.mkdirSync(dayDir, { recursive: true });
  const file = path.join(dayDir, `rollout-2026-05-31T12-09-40-${sessionId}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

const SID_A = '019e7c02-38e3-76f2-b59f-92186e0de89f';
const SID_B = '019e7c02-38e3-76f2-b59f-92186e0de89e';

const SESSION_META = (id: string, cwd: string) => ({
  timestamp: '2026-05-31T03:09:42.886Z',
  type: 'session_meta',
  payload: { id, timestamp: '2026-05-31T03:09:40.971Z', cwd, originator: 'codex-tui' },
});

const DEVELOPER_MESSAGE = {
  timestamp: '2026-05-31T03:09:43.000Z',
  type: 'response_item',
  payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions>...' }] },
};

const ENV_CONTEXT_MESSAGE = {
  timestamp: '2026-05-31T03:09:43.100Z',
  type: 'response_item',
  payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/x</cwd>\n</environment_context>' }] },
};

const USER_MESSAGE = (text: string) => ({
  timestamp: '2026-05-31T03:09:44.000Z',
  type: 'response_item',
  payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
});

const ASSISTANT_MESSAGE = (text: string) => ({
  timestamp: '2026-05-31T03:09:45.000Z',
  type: 'response_item',
  payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
});

const REASONING = (text: string) => ({
  timestamp: '2026-05-31T03:09:44.500Z',
  type: 'response_item',
  payload: { type: 'reasoning', summary: [{ type: 'summary_text', text }], content: null, encrypted_content: 'gAAAA...' },
});

const FUNCTION_CALL = (callId: string) => ({
  timestamp: '2026-05-31T03:09:44.700Z',
  type: 'response_item',
  payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"ls"}', call_id: callId },
});

const FUNCTION_CALL_OUTPUT = (callId: string, output: string) => ({
  timestamp: '2026-05-31T03:09:44.900Z',
  type: 'response_item',
  payload: { type: 'function_call_output', call_id: callId, output },
});

const CUSTOM_TOOL_CALL = (callId: string, name: string, input: string) => ({
  timestamp: '2026-05-31T03:09:44.700Z',
  type: 'response_item',
  payload: { type: 'custom_tool_call', status: 'completed', call_id: callId, name, input },
});

const CUSTOM_TOOL_CALL_OUTPUT = (callId: string, output: unknown) => ({
  timestamp: '2026-05-31T03:09:44.900Z',
  type: 'response_item',
  payload: { type: 'custom_tool_call_output', call_id: callId, output },
});

const EVENT_MSG = {
  timestamp: '2026-05-31T03:09:44.000Z',
  type: 'event_msg',
  payload: { type: 'user_message', message: 'duplicate of response_item', images: [], local_images: [], text_elements: [] },
};

describe('CodexTranscriptSource', () => {
  let dir: string;
  let source: CodexTranscriptSource;

  beforeEach(() => {
    dir = tmpDir();
    source = new CodexTranscriptSource(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('agentType', () => {
    it('is codex', () => {
      expect(source.agentType).toBe('codex');
    });
  });

  describe('listSessions', () => {
    it('returns empty list when sessions dir does not exist', () => {
      const svc = new CodexTranscriptSource(path.join(dir, 'nonexistent'));
      expect(svc.listSessions()).toEqual([]);
    });

    it('lists sessions under the fixed YYYY/MM/DD structure, ordered by mtime descending', () => {
      const fileA = writeSession(dir, SID_A, [
        SESSION_META(SID_A, '/home/user/proj-a'),
        DEVELOPER_MESSAGE,
        ENV_CONTEXT_MESSAGE,
        USER_MESSAGE('Hello from A'),
      ]);
      const fileB = writeSession(dir, SID_B, [
        SESSION_META(SID_B, '/home/user/proj-b'),
        USER_MESSAGE('Hello from B'),
      ]);

      const now = Date.now() / 1000;
      fs.utimesSync(fileA, now, now - 100);
      fs.utimesSync(fileB, now, now);

      const sessions = source.listSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions[0].sessionId).toBe(SID_B);
      expect(sessions[0].agentType).toBe('codex');
      expect(sessions[0].preview).toBe('Hello from B');
      expect(sessions[0].cwd).toBe('/home/user/proj-b');
      expect(sessions[0].projectDir).toBe('proj-b');
      expect(sessions[1].sessionId).toBe(SID_A);
      expect(sessions[1].preview).toBe('Hello from A');
    });

    it('skips the auto-injected <environment_context> message when computing preview', () => {
      writeSession(dir, SID_A, [
        SESSION_META(SID_A, '/home/user/proj-a'),
        ENV_CONTEXT_MESSAGE,
        USER_MESSAGE('Real user text'),
      ]);
      const sessions = source.listSessions();
      expect(sessions[0].preview).toBe('Real user text');
    });
  });

  describe('getSessionCwd', () => {
    it('returns null for an invalid session id', () => {
      expect(source.getSessionCwd('not-a-uuid')).toBeNull();
    });

    it('returns the cwd recorded in session_meta', () => {
      writeSession(dir, SID_A, [SESSION_META(SID_A, '/home/user/proj-a'), USER_MESSAGE('hi')]);
      expect(source.getSessionCwd(SID_A)).toEqual({ cwd: '/home/user/proj-a' });
    });
  });

  describe('getSessionCreatedMs', () => {
    it('returns null for an invalid or nonexistent session id', () => {
      expect(source.getSessionCreatedMs('not-a-uuid')).toBeNull();
      expect(source.getSessionCreatedMs(SID_A)).toBeNull();
    });

    it('parses the creation time from the filename timestamp (rollout-YYYY-MM-DDThh-mm-ss-<uuid>.jsonl) as local time', () => {
      writeSession(dir, SID_A, [SESSION_META(SID_A, '/home/user/proj-a'), USER_MESSAGE('hi')]);
      // The fixture filename encodes 2026-05-31T12-09-40 as local (system-timezone) time, matching
      // the real Codex CLI behavior (see SESSION_FILE_TIMESTAMP_PATTERN comment): the colons are
      // simply replaced with dashes for filesystem safety, with no timezone conversion applied.
      const expected = new Date(2026, 4, 31, 12, 9, 40).getTime();
      expect(source.getSessionCreatedMs(SID_A)).toBe(expected);
    });
  });

  describe('readSession', () => {
    it('returns null when the session file does not exist', () => {
      expect(source.readSession(SID_A)).toBeNull();
    });

    it('converts message/reasoning/function_call/function_call_output and skips developer/event_msg/environment_context', () => {
      writeSession(dir, SID_A, [
        SESSION_META(SID_A, '/home/user/proj-a'),
        DEVELOPER_MESSAGE,
        ENV_CONTEXT_MESSAGE,
        USER_MESSAGE('What is 2+2?'),
        EVENT_MSG,
        REASONING('Thinking about the answer'),
        FUNCTION_CALL('call_1'),
        FUNCTION_CALL_OUTPUT('call_1', '4'),
        ASSISTANT_MESSAGE('The answer is 4.'),
      ]);

      const result = source.readSession(SID_A);
      expect(result).not.toBeNull();
      expect(result!.entries).toHaveLength(5);

      expect(result!.entries[0].type).toBe('user');
      expect(result!.entries[0].blocks).toEqual([{ kind: 'text', text: 'What is 2+2?' }]);

      expect(result!.entries[1].type).toBe('assistant');
      expect(result!.entries[1].blocks).toEqual([{ kind: 'thinking', text: 'Thinking about the answer' }]);

      expect(result!.entries[2].type).toBe('tool');
      expect(result!.entries[2].uuid).toBe('call_1:call');
      expect(result!.entries[2].blocks).toEqual([{ kind: 'tool_use', name: 'exec_command', input: '{"cmd":"ls"}', truncated: false }]);

      expect(result!.entries[3].type).toBe('tool');
      expect(result!.entries[3].uuid).toBe('call_1:output');
      expect(result!.entries[3].blocks).toEqual([{ kind: 'tool_result', text: '4', truncated: false }]);

      expect(result!.entries[4].type).toBe('assistant');
      expect(result!.entries[4].blocks).toEqual([{ kind: 'text', text: 'The answer is 4.' }]);
    });

    it('assigns distinct uuids to function_call and its function_call_output sharing the same call_id', () => {
      writeSession(dir, SID_A, [
        SESSION_META(SID_A, '/home/user/proj-a'),
        FUNCTION_CALL('call_dup'),
        FUNCTION_CALL_OUTPUT('call_dup', 'result'),
      ]);
      const result = source.readSession(SID_A);
      const uuids = result!.entries.map((e) => e.uuid);
      expect(new Set(uuids).size).toBe(uuids.length);
      expect(uuids).toEqual(['call_dup:call', 'call_dup:output']);
    });

    it('converts custom_tool_call/custom_tool_call_output (apply_patch/exec freeform tools) into tool_use/tool_result', () => {
      writeSession(dir, SID_A, [
        SESSION_META(SID_A, '/home/user/proj-a'),
        CUSTOM_TOOL_CALL('call_ctc', 'apply_patch', '*** Begin Patch\n*** End Patch\n'),
        CUSTOM_TOOL_CALL_OUTPUT('call_ctc', 'Success. Updated the following files:\n'),
      ]);
      const result = source.readSession(SID_A);
      expect(result!.entries).toHaveLength(2);

      expect(result!.entries[0].type).toBe('tool');
      expect(result!.entries[0].uuid).toBe('call_ctc:call');
      expect(result!.entries[0].blocks).toEqual([
        { kind: 'tool_use', name: 'apply_patch', input: '*** Begin Patch\n*** End Patch\n', truncated: false },
      ]);

      expect(result!.entries[1].type).toBe('tool');
      expect(result!.entries[1].uuid).toBe('call_ctc:output');
      expect(result!.entries[1].blocks).toEqual([
        { kind: 'tool_result', text: 'Success. Updated the following files:\n', truncated: false },
      ]);
    });

    it('converts an array-form custom_tool_call_output.output into concatenated text', () => {
      writeSession(dir, SID_A, [
        SESSION_META(SID_A, '/home/user/proj-a'),
        CUSTOM_TOOL_CALL('call_arr', 'exec', 'const r = await tools.exec_command({});'),
        CUSTOM_TOOL_CALL_OUTPUT('call_arr', [
          { type: 'input_text', text: 'Script completed' },
          { type: 'input_text', text: 'Output:\nhello' },
        ]),
      ]);
      const result = source.readSession(SID_A);
      expect(result!.entries[1].blocks).toEqual([{ kind: 'tool_result', text: 'Script completed\nOutput:\nhello', truncated: false }]);
    });

    it('assigns stable fallback uuids to entries without a call_id, unique within the batch', () => {
      writeSession(dir, SID_A, [
        SESSION_META(SID_A, '/home/user/proj-a'),
        USER_MESSAGE('first'),
        ASSISTANT_MESSAGE('second'),
      ]);
      const result = source.readSession(SID_A);
      expect(result!.entries).toHaveLength(2);
      const uuids = result!.entries.map((e) => e.uuid);
      expect(new Set(uuids).size).toBe(2);
    });

    it('supports incremental reads via offset', () => {
      writeSession(dir, SID_A, [SESSION_META(SID_A, '/home/user/proj-a'), USER_MESSAGE('first')]);
      const first = source.readSession(SID_A);
      expect(first!.entries).toHaveLength(1);

      const file = path.join(dir, '2026', '05', '31', `rollout-2026-05-31T12-09-40-${SID_A}.jsonl`);
      fs.appendFileSync(file, JSON.stringify(ASSISTANT_MESSAGE('second')) + '\n');

      const second = source.readSession(SID_A, first!.nextOffset);
      expect(second!.entries).toHaveLength(1);
      expect(second!.entries[0].blocks).toEqual([{ kind: 'text', text: 'second' }]);
    });

    it('reuses the cached file path across repeated readSession calls (no re-scan of sessions dir)', () => {
      writeSession(dir, SID_A, [SESSION_META(SID_A, '/home/user/proj-a'), USER_MESSAGE('first')]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const scanSpy = vi.spyOn(source as any, 'scanSessionFiles');

      const first = source.readSession(SID_A);
      expect(first!.entries).toHaveLength(1);
      expect(scanSpy).toHaveBeenCalledTimes(1); // cache miss on first call

      const second = source.readSession(SID_A, first!.nextOffset);
      expect(second!.entries).toHaveLength(0);
      expect(scanSpy).toHaveBeenCalledTimes(1); // cache hit: no additional scan

      source.getSessionCwd(SID_A);
      expect(scanSpy).toHaveBeenCalledTimes(1); // still a cache hit
    });

    it('re-scans when the cached session file has been removed', () => {
      const file = writeSession(dir, SID_A, [SESSION_META(SID_A, '/home/user/proj-a'), USER_MESSAGE('first')]);
      source.readSession(SID_A); // warms the cache
      fs.rmSync(file);

      expect(source.readSession(SID_A)).toBeNull();
    });

    it('skips a malformed JSON line without throwing', () => {
      const file = writeSession(dir, SID_A, [SESSION_META(SID_A, '/home/user/proj-a'), USER_MESSAGE('ok')]);
      fs.appendFileSync(file, 'not json\n');
      fs.appendFileSync(file, JSON.stringify(ASSISTANT_MESSAGE('after')) + '\n');

      const result = source.readSession(SID_A);
      expect(result!.entries.map((e) => e.blocks[0])).toEqual([
        { kind: 'text', text: 'ok' },
        { kind: 'text', text: 'after' },
      ]);
    });
  });

  describe('readSessionBefore', () => {
    it('returns null for an invalid session id', () => {
      expect(source.readSessionBefore('not-a-uuid', 0)).toBeNull();
    });

    it('returns null when the session file does not exist', () => {
      expect(source.readSessionBefore(SID_A, 0)).toBeNull();
    });

    it('drains the session backward with no duplicate entries across multiple before reads', () => {
      const smallWindowSource = new CodexTranscriptSource(dir, { initialReadMaxBytes: 400, incrementalReadMaxBytes: 400 });
      const lines: unknown[] = [SESSION_META(SID_A, '/home/user/proj-a')];
      for (let i = 0; i < 20; i++) lines.push(USER_MESSAGE(`msg-${i}`));
      writeSession(dir, SID_A, lines);

      const initial = smallWindowSource.readSession(SID_A);
      expect(initial!.hasOlder).toBe(true);

      const collected: string[] = initial!.entries.map((e) => (e.blocks[0].kind === 'text' ? e.blocks[0].text : ''));
      let before = initial!.startOffset;
      let hasOlder = initial!.hasOlder;
      let iterations = 0;
      while (hasOlder && iterations < 100) {
        const page = smallWindowSource.readSessionBefore(SID_A, before)!;
        expect(page.prevOffset).toBeLessThan(before);
        collected.unshift(...page.entries.map((e) => (e.blocks[0].kind === 'text' ? e.blocks[0].text : '')));
        before = page.prevOffset;
        hasOlder = page.hasOlder;
        iterations++;
      }

      expect(iterations).toBeGreaterThan(1);
      expect(before).toBe(0);
      expect(collected).toEqual(Array.from({ length: 20 }, (_, i) => `msg-${i}`));
    });
  });
});
