import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HostTranscriptSourceProvider, type TranscriptServer } from './TranscriptSourceProvider';
import { AgentTranscriptSource } from './AgentTranscriptSource';
import type { TranscriptSource } from './TranscriptSource';
import type { AgentTransport } from '../../servers/transport/AgentTransport';

const localSources = [{ agentType: 'claude' }, { agentType: 'codex' }] as unknown as TranscriptSource[];

function server(overrides: Partial<TranscriptServer>): TranscriptServer {
  return { name: 's', type: 'agent', host: '10.0.0.2', agentPort: 3002, agentToken: 't', muxRuntime: 'system', ...overrides };
}

describe('HostTranscriptSourceProvider', () => {
  it('returns the hub\'s own sources for a local server', () => {
    const provider = new HostTranscriptSourceProvider(localSources, { getAgentTransport: vi.fn() });
    expect(provider.forServer(server({ type: 'local' }))).toBe(localSources);
  });

  it.skipIf(process.platform === 'win32')('isolates local session reads and caches by config directory', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-config-'));
    try {
      const dirs = ['one', 'two'].map((name) => path.join(root, name));
      const id = '12345678-1234-1234-1234-123456789abc';
      for (const [index, dir] of dirs.entries()) {
        const project = path.join(dir, 'projects', 'project');
        fs.mkdirSync(project, { recursive: true });
        fs.writeFileSync(path.join(project, `${id}.jsonl`), JSON.stringify({ type: 'user', message: { role: 'user', content: `message ${index}` }, cwd: `/work-${index}`, sessionId: id }) + '\n');
      }
      const provider = new HostTranscriptSourceProvider(localSources, { getAgentTransport: vi.fn() });
      const local = server({ type: 'local' });
      const first = provider.forServer(local, dirs[0])!;
      const second = provider.forServer(local, dirs[1])!;
      expect(provider.forServer(local, dirs[0])).toBe(first);
      expect(first[1]).toBe(localSources[1]);
      expect(await first[0].getSessionCwd(id)).toEqual({ cwd: '/work-0' });
      expect(await second[0].getSessionCwd(id)).toEqual({ cwd: '/work-1' });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('returns null for server types whose conversation logs cannot be read (legacy ssh rows)', () => {
    const getAgentTransport = vi.fn();
    const provider = new HostTranscriptSourceProvider(localSources, { getAgentTransport });
    expect(provider.forServer(server({ type: 'ssh' as unknown as 'agent' }))).toBeNull();
    expect(getAgentTransport).not.toHaveBeenCalled();
  });

  it('builds one agent-backed source per local agent type and reuses them while the transport is the same', () => {
    const transport = { getJson: vi.fn() } as unknown as AgentTransport;
    const provider = new HostTranscriptSourceProvider(localSources, { getAgentTransport: () => transport });

    const first = provider.forServer(server({}));
    expect(first?.map((s) => s.agentType)).toEqual(['claude', 'codex']);
    expect(first?.every((s) => s instanceof AgentTranscriptSource)).toBe(true);
    expect(provider.forServer(server({}))).toBe(first);
  });

  it('rebuilds the sources when the server\'s transport was replaced (token change)', () => {
    let transport = { getJson: vi.fn() } as unknown as AgentTransport;
    const provider = new HostTranscriptSourceProvider(localSources, { getAgentTransport: () => transport });

    const first = provider.forServer(server({}));
    transport = { getJson: vi.fn() } as unknown as AgentTransport;
    expect(provider.forServer(server({}))).not.toBe(first);
  });

  it('keeps separate sources per agent server', () => {
    const provider = new HostTranscriptSourceProvider(localSources, { getAgentTransport: () => ({ getJson: vi.fn() }) as unknown as AgentTransport });
    expect(provider.forServer(server({ name: 'a' }))).not.toBe(provider.forServer(server({ name: 'b' })));
  });
});
