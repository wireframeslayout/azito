import { describe, it, expect } from 'vitest';
import { extractClaudeMcpUiToken, hasCodexConfigUiToken } from './mcpTokenStores';

describe('extractClaudeMcpUiToken', () => {
  it('returns present with the token when mcpServers.azt-mcp.env.AZITO_UI_TOKEN is set', () => {
    const content = JSON.stringify({ mcpServers: { 'azt-mcp': { env: { AZITO_UI_TOKEN: 'deadbeef' } } } });
    expect(extractClaudeMcpUiToken(content)).toEqual({ status: 'present', token: 'deadbeef' });
  });

  it('returns absent when azt-mcp is not registered', () => {
    expect(extractClaudeMcpUiToken(JSON.stringify({ mcpServers: {} }))).toEqual({ status: 'absent' });
  });

  it('returns absent when azt-mcp has no env', () => {
    expect(extractClaudeMcpUiToken(JSON.stringify({ mcpServers: { 'azt-mcp': {} } }))).toEqual({ status: 'absent' });
  });

  it('returns absent when there is no mcpServers key at all', () => {
    expect(extractClaudeMcpUiToken('{}')).toEqual({ status: 'absent' });
  });

  it('returns unreadable with an error message for invalid JSON', () => {
    const result = extractClaudeMcpUiToken('{ not valid json');
    expect(result.status).toBe('unreadable');
    if (result.status === 'unreadable') expect(result.error).toBeTruthy();
  });

  it('respects a custom mcpKey', () => {
    const content = JSON.stringify({ mcpServers: { 'other-mcp': { env: { AZITO_UI_TOKEN: 'x' } } } });
    expect(extractClaudeMcpUiToken(content, 'azt-mcp')).toEqual({ status: 'absent' });
    expect(extractClaudeMcpUiToken(content, 'other-mcp')).toEqual({ status: 'present', token: 'x' });
  });
});

describe('hasCodexConfigUiToken', () => {
  it('detects the standard [mcp_servers.azt-mcp.env] table shape', () => {
    expect(hasCodexConfigUiToken('[mcp_servers.azt-mcp.env]\nAZITO_UI_TOKEN = "deadbeef"\n')).toBe(true);
  });

  it('detects a quoted table header / key variant', () => {
    expect(hasCodexConfigUiToken('[mcp_servers."azt-mcp".env]\n"AZITO_UI_TOKEN" = "deadbeef"\n')).toBe(true);
  });

  it('detects an inline-table form', () => {
    expect(hasCodexConfigUiToken('[mcp_servers.azt-mcp]\nenv = { AZITO_UI_TOKEN = "deadbeef" }\n')).toBe(true);
  });

  it('returns false when the token is absent', () => {
    expect(hasCodexConfigUiToken('[mcp_servers.other]\ncommand = "foo"\n')).toBe(false);
  });

  it('returns false for an empty file', () => {
    expect(hasCodexConfigUiToken('')).toBe(false);
  });
});
