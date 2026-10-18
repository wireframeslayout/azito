import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { Writable } from 'node:stream';
import { redactUrlSecrets, serializeRequestForLog } from './redactUrlSecrets';

describe('redactUrlSecrets', () => {
  it('redacts the token value and keeps other params', () => {
    expect(redactUrlSecrets('/ws?server=local&token=abc123')).toBe('/ws?server=local&token=[REDACTED]');
  });

  it('leaves urls without a secret key unchanged', () => {
    expect(redactUrlSecrets('/ws?mode=events')).toBe('/ws?mode=events');
  });

  it('redacts every duplicated token', () => {
    expect(redactUrlSecrets('/ws?token=abc&cols=80&token=def')).toBe('/ws?token=[REDACTED]&cols=80&token=[REDACTED]');
  });

  it('leaves urls without a query unchanged', () => {
    expect(redactUrlSecrets('/api/health')).toBe('/api/health');
  });

  it('returns an empty string as is', () => {
    expect(redactUrlSecrets('')).toBe('');
  });

  it('redacts an empty token value', () => {
    expect(redactUrlSecrets('/ws?token=')).toBe('/ws?token=[REDACTED]');
  });

  it('redacts a percent-encoded token value', () => {
    expect(redactUrlSecrets('/ws?token=a%20b')).toBe('/ws?token=[REDACTED]');
  });

  it('redacts a token key without a value', () => {
    expect(redactUrlSecrets('/ws?token')).toBe('/ws?token=[REDACTED]');
  });

  it('does not throw on a malformed escape', () => {
    expect(redactUrlSecrets('/ws?%E0%A4%A=1&token=x')).toBe('/ws?%E0%A4%A=1&token=[REDACTED]');
  });
});

describe('serializeRequestForLog', () => {
  const fakeRequest = (overrides: Record<string, unknown> = {}) => ({
    method: 'GET',
    url: '/ws?token=SUPERSECRET&mode=terminal',
    headers: {
      authorization: 'Bearer UI_TOKEN_SECRET',
      'x-agent-token': 'AGENT_TOKEN_SECRET',
      'accept-version': '1.0.0',
      host: 'localhost:3001',
    },
    host: 'localhost:3001',
    ip: '127.0.0.1',
    socket: { remotePort: 54321 },
    ...overrides,
  }) as never;

  it('returns the expected Fastify-default fields with url redacted', () => {
    const result = serializeRequestForLog(fakeRequest());
    expect(result).toEqual({
      method: 'GET',
      url: '/ws?token=[REDACTED]&mode=terminal',
      version: '1.0.0',
      host: 'localhost:3001',
      remoteAddress: '127.0.0.1',
      remotePort: 54321,
    });
  });

  it('never includes a headers key', () => {
    const result = serializeRequestForLog(fakeRequest());
    expect(result).not.toHaveProperty('headers');
  });

  it('does not leak authorization or agent token anywhere in the serialized output', () => {
    const result = serializeRequestForLog(fakeRequest());
    const json = JSON.stringify(result);
    expect(json).not.toContain('UI_TOKEN_SECRET');
    expect(json).not.toContain('AGENT_TOKEN_SECRET');
    expect(json).not.toContain('SUPERSECRET');
  });
});

describe('Fastify integration: log output never contains secrets', () => {
  it('redacts token from logged request URL and excludes headers', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });

    const app = Fastify({
      logger: { stream, serializers: { req: serializeRequestForLog } },
    });
    app.get('/ws', (_req, reply) => reply.send('ok'));

    await app.inject({
      method: 'GET',
      url: '/ws?token=SUPERSECRET&mode=terminal',
      headers: {
        authorization: 'Bearer UI_TOKEN_SECRET',
        'x-agent-token': 'AGENT_TOKEN_SECRET',
      },
    });

    await app.close();

    const allLogs = lines.join('');
    expect(allLogs).toContain('[REDACTED]');
    expect(allLogs).not.toContain('SUPERSECRET');
    expect(allLogs).not.toContain('UI_TOKEN_SECRET');
    expect(allLogs).not.toContain('AGENT_TOKEN_SECRET');
  });
});
