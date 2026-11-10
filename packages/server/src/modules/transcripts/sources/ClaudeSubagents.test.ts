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
  it('isolates malformed metadata and reads sidechain entries with paging', () => {
    const { source, dir } = fixture();
    fs.writeFileSync(path.join(dir, 'agent-a123.meta.json'), JSON.stringify({ name: 'worker', agentType: 'Explore', description: 'Investigate', finished: true }));
    fs.writeFileSync(path.join(dir, 'agent-b456.meta.json'), '{bad');
    fs.writeFileSync(path.join(dir, 'agent-a123.jsonl'), `${JSON.stringify({ uuid: 'one', type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] } })}\n`);
    expect(source.listSubagents(session)).toEqual([{ id: 'a123', name: 'worker', routingName: 'worker', description: 'Investigate', agentType: 'Explore', model: null, status: 'finished' }]);
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
