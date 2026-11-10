import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeTranscriptSource } from './ClaudeTranscriptSource';

const session = '12345678-1234-1234-1234-123456789abc';
const roots: string[] = [];
function fixture(): { source: ClaudeTranscriptSource; dir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subagents-'));
  roots.push(root);
  const project = path.join(root, 'project');
  const dir = path.join(project, session, 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(project, `${session}.jsonl`), '');
  return { source: new ClaudeTranscriptSource(root), dir };
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('Claude subagents', () => {
  it('filters confirmed sidechain meta reminders and advances all reading offsets', () => {
    const { source, dir } = fixture();
    const reminder = '<system-reminder>generated</system-reminder>';
    const row = (uuid: string, content: unknown, isMeta = false) => ({ type: 'user', uuid, isSidechain: true, isMeta, message: { content } });
    const file = path.join(dir, 'agent-a123.jsonl');
    fs.writeFileSync(file, [row('visible', reminder), row('hidden', reminder, true), row('mixed', [{ type: 'text', text: 'hello' }, { type: 'text', text: reminder }], true)].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    const first = source.readSubagent(session, 'a123');
    expect(first && 'nextOffset' in first).toBe(true);
    if (!first || !('nextOffset' in first)) throw new Error('expected forward result');
    expect(first.entries.map((e) => e.uuid)).toEqual(['visible', 'mixed']);
    fs.appendFileSync(file, JSON.stringify(row('later', reminder, true)) + '\n');
    const next = source.readSubagent(session, 'a123', first.nextOffset);
    expect(next && 'nextOffset' in next && next.entries).toEqual([]);
    expect(next && 'nextOffset' in next && next.nextOffset).toBe(fs.statSync(file).size);
    const before = source.readSubagent(session, 'a123', undefined, fs.statSync(file).size);
    expect(before && 'prevOffset' in before && before.entries.map((e) => e.uuid)).toEqual(['visible', 'mixed']);
    expect(before && 'prevOffset' in before && before.prevOffset).toBe(0);
  });
  it('isolates malformed metadata and reads sidechain entries with paging', () => {
    const { source, dir } = fixture();
    fs.writeFileSync(path.join(dir, 'agent-a123.meta.json'), JSON.stringify({ name: 'worker', agentType: 'Explore', description: 'Investigate', finished: true }));
    fs.writeFileSync(path.join(dir, 'agent-b456.meta.json'), '{bad');
    fs.writeFileSync(path.join(dir, 'agent-a123.jsonl'), `${JSON.stringify({ uuid: 'one', type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] } })}\n`);
    expect(source.listSubagents(session)).toEqual([{ id: 'a123', name: 'worker', description: 'Investigate', agentType: 'Explore', model: null, status: 'finished' }]);
    const first = source.readSubagent(session, 'a123');
    expect(first?.entries[0]?.blocks).toEqual([{ kind: 'text', text: 'Hello' }]);
    expect(first && 'nextOffset' in first && source.readSubagent(session, 'a123', first.nextOffset)?.entries).toEqual([]);
  });

  it('orders names deterministically, uses the description, and skips oversized metadata', () => {
    const { source, dir } = fixture();
    fs.writeFileSync(path.join(dir, 'agent-b.meta.json'), JSON.stringify({ agentType: 'Task', description: 'Second', model: 'model' }));
    fs.writeFileSync(path.join(dir, 'agent-a.meta.json'), JSON.stringify({ agentType: 'Task', description: 'First' }));
    fs.writeFileSync(path.join(dir, 'agent-c.meta.json'), JSON.stringify({ agentType: 'Task', description: 'x'.repeat(65536) }));
    expect(source.listSubagents(session)?.map(({ name }) => name)).toEqual(['First', 'Second']);
  });

  it('rejects traversal, excludes symlinks and distinguishes missing sessions', () => {
    const { source, dir } = fixture();
    expect(() => source.listSubagents('../escape')).toThrow();
    expect(() => source.readSubagent(session, '../escape')).toThrow();
    fs.symlinkSync('/etc/passwd', path.join(dir, 'agent-a123.jsonl'));
    expect(() => source.readSubagent(session, 'a123')).toThrow();
    expect(source.listSubagents('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')).toBeNull();
  });
});
