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

const TURN_ABORTED_EVENT = {
  timestamp: '2026-05-31T03:09:46.000Z',
  type: 'event_msg',
  payload: { type: 'turn_aborted', reason: 'interrupted' },
};

const CUSTOM_TOOL_CALL_ABORTED_OUTPUT = (callId: string) => ({
  timestamp: '2026-05-31T03:09:45.900Z',
  type: 'response_item',
  payload: { type: 'custom_tool_call_output', call_id: callId, output: 'aborted by user after 4s' },
});

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

    it('converts an event_msg turn_aborted record into an interrupted entry', () => {
      writeSession(dir, SID_A, [
        SESSION_META(SID_A, '/home/user/proj-a'),
        USER_MESSAGE('do the thing'),
        FUNCTION_CALL('call_1'),
        TURN_ABORTED_EVENT,
      ]);
      const result = source.readSession(SID_A);
      expect(result!.entries).toHaveLength(3);
      expect(result!.entries[2]).toMatchObject({ type: 'interrupted', timestamp: '2026-05-31T03:09:46.000Z', blocks: [] });
    });

    it('keeps ignoring other event_msg subtypes (only turn_aborted is converted)', () => {
      writeSession(dir, SID_A, [SESSION_META(SID_A, '/home/user/proj-a'), EVENT_MSG, USER_MESSAGE('hi')]);
      const result = source.readSession(SID_A);
      expect(result!.entries).toHaveLength(1);
      expect(result!.entries[0].type).toBe('user');
    });

    it('leaves custom_tool_call_output "aborted by user" text as a normal tool_result (not converted)', () => {
      writeSession(dir, SID_A, [
        SESSION_META(SID_A, '/home/user/proj-a'),
        CUSTOM_TOOL_CALL('call_1', 'exec', 'ls'),
        CUSTOM_TOOL_CALL_ABORTED_OUTPUT('call_1'),
      ]);
      const result = source.readSession(SID_A);
      expect(result!.entries[1]).toMatchObject({ type: 'tool', blocks: [{ kind: 'tool_result', text: 'aborted by user after 4s', truncated: false }] });
    });
  });

  describe('assistant model from turn_context (Issue #338 followup)', () => {
    const TURN_CONTEXT = (model: string) => ({
      timestamp: '2026-05-31T03:09:43.500Z',
      type: 'turn_context',
      payload: { turn_id: 't1', cwd: '/home/user/proj-a', model, approval_policy: 'on-request' },
    });

    it('attaches turn_context.payload.model to subsequent message/reasoning assistant entries', () => {
      writeSession(dir, SID_A, [
        SESSION_META(SID_A, '/home/user/proj-a'),
        USER_MESSAGE('hi'),
        TURN_CONTEXT('gpt-5.2-codex'),
        REASONING('thinking...'),
        ASSISTANT_MESSAGE('hello there'),
      ]);
      const result = source.readSession(SID_A);
      expect(result!.entries).toHaveLength(3);
      expect(result!.entries[0].model).toBeUndefined(); // user
      expect(result!.entries[1].model).toBe('gpt-5.2-codex'); // reasoning → assistant
      expect(result!.entries[2].model).toBe('gpt-5.2-codex'); // assistant message
    });

    it('does not attach model to non-assistant entries (function_call/tool)', () => {
      writeSession(dir, SID_A, [
        SESSION_META(SID_A, '/home/user/proj-a'),
        TURN_CONTEXT('gpt-5.2-codex'),
        FUNCTION_CALL('call_1'),
        FUNCTION_CALL_OUTPUT('call_1', 'ok'),
      ]);
      const result = source.readSession(SID_A);
      expect(result!.entries[0].model).toBeUndefined();
      expect(result!.entries[1].model).toBeUndefined();
    });

    it('updates model when a later turn_context reports a different model', () => {
      writeSession(dir, SID_A, [
        SESSION_META(SID_A, '/home/user/proj-a'),
        TURN_CONTEXT('gpt-5.2-codex'),
        ASSISTANT_MESSAGE('first turn'),
        TURN_CONTEXT('gpt-5.6-terra'),
        ASSISTANT_MESSAGE('second turn'),
      ]);
      const result = source.readSession(SID_A);
      expect(result!.entries[0].model).toBe('gpt-5.2-codex');
      expect(result!.entries[1].model).toBe('gpt-5.6-terra');
    });

    it('leaves model undefined when no turn_context has been seen yet', () => {
      writeSession(dir, SID_A, [SESSION_META(SID_A, '/home/user/proj-a'), ASSISTANT_MESSAGE('no context yet')]);
      const result = source.readSession(SID_A);
      expect(result!.entries[0].model).toBeUndefined();
    });

    it('carries the model across separate readSession calls when turn_context and the assistant reply land in different polling reads (Important 1 regression)', () => {
      const file = writeSession(dir, SID_A, [SESSION_META(SID_A, '/home/user/proj-a'), USER_MESSAGE('hi'), TURN_CONTEXT('gpt-5.2-codex')]);
      // First read: only session_meta/user/turn_context exist yet — turn_context is observed but no assistant entry to attach it to.
      const first = source.readSession(SID_A);
      expect(first!.entries.every((e) => e.model === undefined)).toBe(true);

      // Simulate the assistant reply landing in a *separate* live-poll read (a fresh parseLine closure).
      fs.appendFileSync(file, JSON.stringify(ASSISTANT_MESSAGE('hello there')) + '\n');
      const second = source.readSession(SID_A, first!.nextOffset);
      expect(second!.entries).toHaveLength(1);
      expect(second!.entries[0].model).toBe('gpt-5.2-codex');
    });

    it('carries the model across two consecutive incremental reads (turn_context in one poll, assistant reply in the next)', () => {
      const file = writeSession(dir, SID_A, [SESSION_META(SID_A, '/home/user/proj-a')]);
      const initial = source.readSession(SID_A);

      fs.appendFileSync(file, JSON.stringify(TURN_CONTEXT('gpt-5.6-terra')) + '\n');
      const afterTurnContext = source.readSession(SID_A, initial!.nextOffset);
      expect(afterTurnContext!.entries).toHaveLength(0); // turn_context itself is not an entry

      fs.appendFileSync(file, JSON.stringify(ASSISTANT_MESSAGE('second poll reply')) + '\n');
      const afterAssistant = source.readSession(SID_A, afterTurnContext!.nextOffset);
      expect(afterAssistant!.entries).toHaveLength(1);
      expect(afterAssistant!.entries[0].model).toBe('gpt-5.6-terra');
    });

    it('does not seed readSessionBefore (backward pagination) from the forward-read model cache', () => {
      const file = writeSession(dir, SID_A, [SESSION_META(SID_A, '/home/user/proj-a'), TURN_CONTEXT('gpt-5.2-codex')]);
      const assistantLine = JSON.stringify(ASSISTANT_MESSAGE('forward reply')) + '\n';

      // A small incrementalReadMaxBytes keeps the later incremental/backward windows narrow enough to
      // contain only the trailing assistant line, not the turn_context line before it — isolating
      // whether the forward-read cache leaks into a backward page.
      const narrowSource = new CodexTranscriptSource(dir, { incrementalReadMaxBytes: Buffer.byteLength(assistantLine) + 10 });

      // Prime the forward cache: the initial read observes session_meta + turn_context (small file, one window).
      const primed = narrowSource.readSession(SID_A);
      expect(primed!.entries).toHaveLength(0);

      // The assistant reply arrives afterwards, in a separate (narrow) incremental read that seeds from the cache.
      fs.appendFileSync(file, assistantLine);
      const forward = narrowSource.readSession(SID_A, primed!.nextOffset);
      expect(forward!.entries).toHaveLength(1);
      expect(forward!.entries[0].model).toBe('gpt-5.2-codex');

      // A backward page ending right after that same assistant entry, narrow enough to exclude the
      // turn_context line, must not pick up the (now-primed) cached model.
      const before = narrowSource.readSessionBefore(SID_A, forward!.nextOffset);
      const assistantEntries = before!.entries.filter((e) => e.type === 'assistant');
      expect(assistantEntries.length).toBeGreaterThan(0);
      for (const entry of assistantEntries) expect(entry.model).toBeUndefined();
    });
  });

  describe('getSessionTailState', () => {
    it('returns unknown for a nonexistent session', async () => {
      expect(await source.getSessionTailState(SID_A)).toBe('unknown');
    });

    it('returns terminal when the last meaningful record is a turn_aborted event', async () => {
      writeSession(dir, SID_A, [
        SESSION_META(SID_A, '/home/user/proj-a'),
        USER_MESSAGE('do it'),
        FUNCTION_CALL('call_1'),
        TURN_ABORTED_EVENT,
      ]);
      expect(await source.getSessionTailState(SID_A)).toBe('terminal');
    });

    it('returns terminal when the last meaningful record is the final assistant text', async () => {
      writeSession(dir, SID_A, [SESSION_META(SID_A, '/home/user/proj-a'), USER_MESSAGE('hi'), ASSISTANT_MESSAGE('done')]);
      expect(await source.getSessionTailState(SID_A)).toBe('terminal');
    });

    it('returns in_progress when the last meaningful record is a reasoning block (mid-turn thinking, not a final response)', async () => {
      writeSession(dir, SID_A, [SESSION_META(SID_A, '/home/user/proj-a'), USER_MESSAGE('hi'), REASONING('thinking about it')]);
      expect(await source.getSessionTailState(SID_A)).toBe('in_progress');
    });

    it('returns in_progress when the last meaningful record is a function_call (tool in flight)', async () => {
      writeSession(dir, SID_A, [SESSION_META(SID_A, '/home/user/proj-a'), USER_MESSAGE('hi'), FUNCTION_CALL('call_1')]);
      expect(await source.getSessionTailState(SID_A)).toBe('in_progress');
    });

    it('returns in_progress when the last meaningful record is a function_call_output (awaiting next turn)', async () => {
      writeSession(dir, SID_A, [
        SESSION_META(SID_A, '/home/user/proj-a'),
        FUNCTION_CALL('call_1'),
        FUNCTION_CALL_OUTPUT('call_1', 'result'),
      ]);
      expect(await source.getSessionTailState(SID_A)).toBe('in_progress');
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
