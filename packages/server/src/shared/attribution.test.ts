import { describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { recordAttribution } from './attribution';

describe('window attribution', () => {
  it('records valid headers and ignores missing or invalid values', () => {
    const recordInteraction = vi.fn(); const warn = vi.fn();
    const request = (header?: string) => ({ headers: { 'x-azito-window-id': header }, log: { warn } }) as unknown as FastifyRequest;
    recordAttribution(request('W-12'), { recordInteraction }, { windowId: 4 });
    recordAttribution(request('garbage'), { recordInteraction }, { windowId: 4 });
    recordAttribution(request(), { recordInteraction }, { taskId: 8 });
    expect(recordInteraction).toHaveBeenCalledOnce();
    expect(recordInteraction).toHaveBeenCalledWith(12, { windowId: 4 });
    expect(warn).not.toHaveBeenCalled();
  });
  it('warns when recording fails without changing the response', () => {
    const warn = vi.fn(); const err = new Error('db failure');
    const request = { headers: { 'x-azito-window-id': '12' }, log: { warn } } as unknown as FastifyRequest;
    expect(() => recordAttribution(request, { recordInteraction: () => { throw err; } }, { taskId: 8 })).not.toThrow();
    expect(warn).toHaveBeenCalledWith({ err }, expect.any(String));
  });
});
