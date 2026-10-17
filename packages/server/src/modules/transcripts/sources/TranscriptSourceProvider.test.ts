import { describe, it, expect, vi } from 'vitest';
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
