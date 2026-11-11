import { describe, it, expect } from 'vitest';
import { AgentRegistry, createDefaultRegistry, getAgentModels, getAgentTypes, getAgentsForContext, listAgentDefinitions } from './registry';
import type { IAgentProvider } from './AgentProvider';

function fakeProvider(type: string): IAgentProvider {
  return {
    definition: {
      type,
      label: type,
      kind: 'cli',
      launchable: true,
      contexts: ['worker'],
      headlessCommand: null,
      models: [],
    },
    buildLaunch: () => null,
    buildHeadlessCommand: () => null,
    createSessionStrategy: () => null,
  };
}

describe('AgentRegistry', () => {
  it('registers and retrieves a provider by type', () => {
    const registry = new AgentRegistry();
    const provider = fakeProvider('fake');
    registry.register(provider);
    expect(registry.get('fake')).toBe(provider);
    expect(registry.tryGet('fake')).toBe(provider);
  });

  it('throws when registering the same type twice', () => {
    const registry = new AgentRegistry();
    registry.register(fakeProvider('dup'));
    expect(() => registry.register(fakeProvider('dup'))).toThrow(/already registered/);
  });

  it('get() throws for an unknown type (fail fast, no fallback)', () => {
    const registry = new AgentRegistry();
    expect(() => registry.get('nope')).toThrow(/Unknown agent type/);
  });

  it('tryGet() returns null for an unknown type', () => {
    const registry = new AgentRegistry();
    expect(registry.tryGet('nope')).toBeNull();
  });

  it('list() returns all registered providers', () => {
    const registry = new AgentRegistry();
    registry.register(fakeProvider('a'));
    registry.register(fakeProvider('b'));
    expect(registry.list().map((p) => p.definition.type).sort()).toEqual(['a', 'b']);
  });
});

describe('createDefaultRegistry', () => {
  it('registers claude, codex, generic exactly once', () => {
    const registry = createDefaultRegistry();
    const types = registry.list().map((p) => p.definition.type).sort();
    expect(types).toEqual(['claude', 'codex', 'generic']);
  });
});

describe('catalog helpers (default registry)', () => {
  it('listAgentDefinitions returns all agent definitions', () => {
    expect(listAgentDefinitions().map((a) => a.type).sort()).toEqual(['claude', 'codex', 'generic']);
  });

  it('listAgentDefinitions launchCommands omit MCP blocking flags (Issue #471)', () => {
    const defs = listAgentDefinitions();
    const claude = defs.find((d) => d.type === 'claude')!;
    const codex = defs.find((d) => d.type === 'codex')!;
    expect(claude.launchCommand).not.toContain('--strict-mcp-config');
    expect(codex.launchCommand).not.toContain('mcp_servers.azt-mcp.enabled=false');
    expect(codex.launchCommand).not.toContain('mcp_servers.azt-mcp.command=');
  });

  it('getAgentsForContext filters by context', () => {
    const subagentAgents = getAgentsForContext('subagent').map((a) => a.type).sort();
    expect(subagentAgents).toEqual(['claude', 'codex']);
  });

  it('getAgentModels returns models for a known type and [] for unknown', () => {
    expect(getAgentModels('claude').length).toBeGreaterThan(0);
    expect(getAgentModels('nonexistent')).toEqual([]);
  });

  it('includes current Claude model options with 1M context variants', () => {
    expect(getAgentModels('claude')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'fable' }),
        { id: 'claude-fable-5-2', label: 'Fable 5.2 — 1M ctx' },
        { id: 'claude-haiku-5-5', label: 'Haiku 5.5 — 1M ctx' },
        expect.objectContaining({ id: 'claude-opus-5' }),
        expect.objectContaining({ id: 'claude-opus-5[1m]' }),
        expect.objectContaining({ id: 'claude-fable-5' }),
        expect.objectContaining({ id: 'claude-opus-4-8' }),
        expect.objectContaining({ id: 'claude-opus-4-6' }),
        expect.objectContaining({ id: 'claude-opus-4-6[1m]' }),
        expect.objectContaining({ id: 'claude-sonnet-5' }),
        expect.objectContaining({ id: 'claude-sonnet-4-6[1m]' }),
      ]),
    );
  });

  it('includes current Codex model options', () => {
    expect(getAgentModels('codex')).toEqual(
      expect.arrayContaining([
        { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra' },
        expect.objectContaining({ id: 'gpt-5.6-sol' }),
        expect.objectContaining({ id: 'gpt-5.6-terra' }),
        expect.objectContaining({ id: 'gpt-5.6-luna' }),
      ]),
    );
  });

  it('keeps model lists valid and their default first choices unchanged', () => {
    for (const type of ['claude', 'codex']) {
      const models = getAgentModels(type);
      expect(new Set(models.map((model) => model.id)).size).toBe(models.length);
      for (const model of models) {
        expect(model.id.trim()).not.toBe('');
        expect(model.label.trim()).not.toBe('');
      }
    }
    expect(getAgentModels('claude')[0].id).toBe('opus');
    expect(getAgentModels('codex')[0].id).toBe('gpt-6.1-sol');
    const claudeIds = getAgentModels('claude').map((model) => model.id);
    expect(claudeIds).not.toContain('claude-fable-5-2[1m]');
    expect(claudeIds).not.toContain('claude-haiku-5-5[1m]');
  });

  it('getAgentTypes returns worker-context types', () => {
    expect(getAgentTypes().sort()).toEqual(['claude', 'codex', 'generic']);
  });
});
