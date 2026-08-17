import { describe, it, expect, vi } from 'vitest';
import { recordAuditBestEffort } from './recordAuditBestEffort';
import type { AuditLogService } from './AuditLogService';

function makeAuditLogService(recordImpl: (...args: unknown[]) => void = () => {}): AuditLogService {
  return { record: vi.fn(recordImpl) } as unknown as AuditLogService;
}

describe('recordAuditBestEffort', () => {
  it('calls through to auditLogService.record with the given entry', () => {
    const auditLogService = makeAuditLogService();
    recordAuditBestEffort(auditLogService, { actorClass: 'runtime', actorId: null, event: 'x', detail: { a: 1 } });
    expect(auditLogService.record).toHaveBeenCalledWith({ actorClass: 'runtime', actorId: null, event: 'x', detail: { a: 1 } });
  });

  it('swallows a thrown error from record() rather than propagating it', () => {
    const auditLogService = makeAuditLogService(() => {
      throw new Error('disk full');
    });
    expect(() => recordAuditBestEffort(auditLogService, { actorClass: 'runtime', actorId: null, event: 'x' })).not.toThrow();
  });

  it('invokes the onError callback with the thrown error when record() fails', () => {
    const auditLogService = makeAuditLogService(() => {
      throw new Error('disk full');
    });
    const onError = vi.fn();
    recordAuditBestEffort(auditLogService, { actorClass: 'runtime', actorId: null, event: 'x' }, onError);
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('does not invoke onError when record() succeeds', () => {
    const auditLogService = makeAuditLogService();
    const onError = vi.fn();
    recordAuditBestEffort(auditLogService, { actorClass: 'runtime', actorId: null, event: 'x' }, onError);
    expect(onError).not.toHaveBeenCalled();
  });

  it('is a no-op (never throws) when auditLogService itself is undefined', () => {
    expect(() => recordAuditBestEffort(undefined, { actorClass: 'runtime', actorId: null, event: 'x' })).not.toThrow();
  });
});
