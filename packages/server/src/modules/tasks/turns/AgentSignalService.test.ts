import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentSignalService } from './AgentSignalService';
import { buildTurnToken } from './AgentTurn';
import { TurnSignalHub } from './TurnSignalHub';
import type { SqliteAgentTurnRepository } from './SqliteAgentTurnRepository';
import type { IExecutionLogRepository } from '../ExecutionLog';
import type { AgentTurn } from './AgentTurn';
import type { AuditLogService } from '../../../shared/audit/AuditLogService';

function makeTurn(overrides: Partial<AgentTurn> = {}): AgentTurn {
  return {
    id: 1,
    taskId: 10,
    unitId: 5,
    kind: 'phase',
    phase: 'implementing',
    nonce: 'nonce-1',
    status: 'running',
    completionSource: null,
    confidence: null,
    serverName: 'local',
    tmuxTarget: 'azito:1.0',
    outputFilePath: null,
    startedAt: '2026-07-08T00:00:00.000Z',
    endedAt: null,
    ...overrides,
  };
}

function makeTurnRepo(turn: AgentTurn | null): SqliteAgentTurnRepository {
  return {
    findById: vi.fn().mockReturnValue(turn),
    appendEvent: vi.fn(),
    markEnded: vi.fn(),
    supersedeRunning: vi.fn(),
    create: vi.fn(),
    findLatestByTask: vi.fn(),
    findLatestByTaskPhase: vi.fn(),
  } as unknown as SqliteAgentTurnRepository;
}

function makeLogRepo(): IExecutionLogRepository {
  return { append: vi.fn(), findByTask: vi.fn(), findByUnit: vi.fn() };
}

function makeAuditLogService(): AuditLogService {
  return { record: vi.fn() } as unknown as AuditLogService;
}

describe('AgentSignalService', () => {
  let hub: TurnSignalHub;

  beforeEach(() => {
    hub = new TurnSignalHub();
  });

  it('returns 400 when the body is not an object', () => {
    const turnRepo = makeTurnRepo(null);
    const service = new AgentSignalService(turnRepo, hub, makeLogRepo(), makeAuditLogService());

    const result = service.handleSignal('not-an-object');

    expect(result.status).toBe(400);
    expect(turnRepo.findById).not.toHaveBeenCalled();
  });

  it('returns 400 when turnToken is missing', () => {
    const turnRepo = makeTurnRepo(null);
    const service = new AgentSignalService(turnRepo, hub, makeLogRepo(), makeAuditLogService());

    const result = service.handleSignal({ type: 'progress' });

    expect(result.status).toBe(400);
  });

  it('returns 400 when turnToken has an invalid format', () => {
    const turnRepo = makeTurnRepo(null);
    const service = new AgentSignalService(turnRepo, hub, makeLogRepo(), makeAuditLogService());

    const result = service.handleSignal({ turnToken: 'not-a-valid-token', type: 'progress' });

    expect(result.status).toBe(400);
  });

  it('returns 400 when type is not one of the known signal types', () => {
    const turnRepo = makeTurnRepo(null);
    const service = new AgentSignalService(turnRepo, hub, makeLogRepo(), makeAuditLogService());

    const result = service.handleSignal({ turnToken: '10.1.nonce-1', type: 'bogus' });

    expect(result.status).toBe(400);
  });

  it('returns 400 when testFailed is present but not a boolean', () => {
    const turnRepo = makeTurnRepo(null);
    const service = new AgentSignalService(turnRepo, hub, makeLogRepo(), makeAuditLogService());

    const result = service.handleSignal({ turnToken: '10.1.nonce-1', type: 'complete', testFailed: 'yes' });

    expect(result.status).toBe(400);
  });

  it('returns 400 when type is "questions" without a questions array', () => {
    const turnRepo = makeTurnRepo(null);
    const service = new AgentSignalService(turnRepo, hub, makeLogRepo(), makeAuditLogService());

    const result = service.handleSignal({ turnToken: '10.1.nonce-1', type: 'questions' });

    expect(result.status).toBe(400);
  });

  it('returns 404 when the turn does not exist, records a metadata-only audit event, and writes nothing to agent_turn_events', () => {
    const turnRepo = makeTurnRepo(null);
    const auditLogService = makeAuditLogService();
    const service = new AgentSignalService(turnRepo, hub, makeLogRepo(), auditLogService);

    const result = service.handleSignal({ turnToken: '10.1.nonce-1', type: 'progress' });

    expect(result.status).toBe(404);
    expect(turnRepo.appendEvent).not.toHaveBeenCalled();
    expect(auditLogService.record).toHaveBeenCalledWith(expect.objectContaining({
      event: 'agent_signal.rejected',
      detail: expect.objectContaining({ reason: 'turn_not_found' }),
    }));
  });

  // Issue #28 third-party review, Minor finding: `auditLogService.record()`
  // in the rejection paths used to be called unguarded — a write failure
  // there (disk full, locked DB, ...) propagated out of handleSignal and
  // turned the intended 404 into an uncaught exception (a 500 at the route
  // layer), silently upgrading the caller's visible failure mode. It must
  // stay best-effort: the 404 is returned regardless of whether the audit
  // write itself succeeded.
  it('still returns 404 when the audit log write fails for a not-found turn (best-effort)', () => {
    const turnRepo = makeTurnRepo(null);
    const auditLogService = makeAuditLogService();
    (auditLogService.record as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('disk full');
    });
    const service = new AgentSignalService(turnRepo, hub, makeLogRepo(), auditLogService);

    const result = service.handleSignal({ turnToken: '10.1.nonce-1', type: 'progress' });

    expect(result.status).toBe(404);
    expect(auditLogService.record).toHaveBeenCalled();
  });

  // Issue #28 third-party review, Important finding: an unauthenticated
  // caller could previously brute-force turnIds and grow agent_turn_events
  // without bound (each row carrying the full, up-to-256KiB request body)
  // before ever failing auth. Repeating a resolvable-but-mismatched turnToken
  // must never write a turn event, no matter how many times it's retried.
  it('never appends to agent_turn_events across repeated invalid-credential attempts (flood/DB-bloat guard)', () => {
    const turn = makeTurn({ taskId: 999 });
    const turnRepo = makeTurnRepo(turn);
    const auditLogService = makeAuditLogService();
    const service = new AgentSignalService(turnRepo, hub, makeLogRepo(), auditLogService);

    for (let i = 0; i < 25; i++) {
      const result = service.handleSignal({ turnToken: '10.1.nonce-1', type: 'progress', output: 'x'.repeat(1000) });
      expect(result.status).toBe(403);
    }

    expect(turnRepo.appendEvent).not.toHaveBeenCalled();
  });

  it('returns 403, records a metadata-only audit event (no request body), and writes nothing to agent_turn_events when taskId does not match the resolved turn', () => {
    const turn = makeTurn({ taskId: 999 });
    const turnRepo = makeTurnRepo(turn);
    const auditLogService = makeAuditLogService();
    const service = new AgentSignalService(turnRepo, hub, makeLogRepo(), auditLogService);

    const result = service.handleSignal({ turnToken: '10.1.nonce-1', type: 'progress', output: 'sensitive-body-content' });

    expect(result.status).toBe(403);
    expect(turnRepo.appendEvent).not.toHaveBeenCalled();
    expect(auditLogService.record).toHaveBeenCalledWith(expect.objectContaining({
      event: 'agent_signal.rejected',
      detail: expect.objectContaining({ reason: 'turn_mismatch', turnId: turn.id }),
    }));
    // The raw request body must never appear in the audit detail either.
    const call = (auditLogService.record as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(JSON.stringify(call)).not.toContain('sensitive-body-content');
  });

  it('still returns 403 when the audit log write fails for a turn_mismatch rejection (best-effort)', () => {
    const turn = makeTurn({ taskId: 999 });
    const turnRepo = makeTurnRepo(turn);
    const auditLogService = makeAuditLogService();
    (auditLogService.record as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('disk full');
    });
    const service = new AgentSignalService(turnRepo, hub, makeLogRepo(), auditLogService);

    const result = service.handleSignal({ turnToken: '10.1.nonce-1', type: 'progress' });

    expect(result.status).toBe(403);
    expect(auditLogService.record).toHaveBeenCalled();
  });

  it('returns 403 and writes nothing to agent_turn_events when nonce does not match the resolved turn', () => {
    const turn = makeTurn({ taskId: 10, nonce: 'different-nonce' });
    const turnRepo = makeTurnRepo(turn);
    const service = new AgentSignalService(turnRepo, hub, makeLogRepo(), makeAuditLogService());

    const result = service.handleSignal({ turnToken: '10.1.nonce-1', type: 'progress' });

    expect(result.status).toBe(403);
    expect(turnRepo.appendEvent).not.toHaveBeenCalled();
  });

  it('returns 200 duplicate=true and logs a "duplicate" event when the turn is already terminal', () => {
    const turn = makeTurn({ status: 'completed' });
    const turnRepo = makeTurnRepo(turn);
    const service = new AgentSignalService(turnRepo, hub, makeLogRepo(), makeAuditLogService());

    const result = service.handleSignal({ turnToken: buildTurnToken(turn), type: 'progress' });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true, duplicate: true });
    expect(turnRepo.appendEvent).toHaveBeenCalledWith(turn.id, expect.objectContaining({ type: 'duplicate' }));
    expect(turnRepo.markEnded).not.toHaveBeenCalled();
  });

  it('marks the turn completed when type is "complete" and testFailed is false', () => {
    const turn = makeTurn();
    const turnRepo = makeTurnRepo(turn);
    const service = new AgentSignalService(turnRepo, hub, makeLogRepo(), makeAuditLogService());

    const result = service.handleSignal({ turnToken: buildTurnToken(turn), type: 'complete', testFailed: false });

    expect(result.status).toBe(200);
    expect(turnRepo.markEnded).toHaveBeenCalledWith(turn.id, {
      status: 'completed',
      completionSource: 'azitoctl',
      confidence: 'explicit',
    });
  });

  it('marks the turn completed and returns 200 when type is "complete" without testFailed (azitoctl default)', () => {
    const turn = makeTurn();
    const turnRepo = makeTurnRepo(turn);
    const service = new AgentSignalService(turnRepo, hub, makeLogRepo(), makeAuditLogService());
    const received: unknown[] = [];
    hub.subscribe(turn.id, (signal) => received.push(signal));

    const result = service.handleSignal({ turnToken: buildTurnToken(turn), type: 'complete' });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true });
    expect(turnRepo.markEnded).toHaveBeenCalledWith(turn.id, {
      status: 'completed',
      completionSource: 'azitoctl',
      confidence: 'explicit',
    });
    expect(received).toEqual([{ type: 'complete', testFailed: false, summary: undefined, output: undefined }]);
  });

  it('marks the turn test_failed when type is "complete" and testFailed is true', () => {
    const turn = makeTurn();
    const turnRepo = makeTurnRepo(turn);
    const service = new AgentSignalService(turnRepo, hub, makeLogRepo(), makeAuditLogService());

    const result = service.handleSignal({ turnToken: buildTurnToken(turn), type: 'complete', testFailed: true });

    expect(result.status).toBe(200);
    expect(turnRepo.markEnded).toHaveBeenCalledWith(turn.id, {
      status: 'test_failed',
      completionSource: 'azitoctl',
      confidence: 'explicit',
    });
  });

  it('marks the turn questions when type is "questions"', () => {
    const turn = makeTurn();
    const turnRepo = makeTurnRepo(turn);
    const service = new AgentSignalService(turnRepo, hub, makeLogRepo(), makeAuditLogService());

    const result = service.handleSignal({ turnToken: buildTurnToken(turn), type: 'questions', questions: [{ text: 'q1' }] });

    expect(result.status).toBe(200);
    expect(turnRepo.markEnded).toHaveBeenCalledWith(turn.id, {
      status: 'questions',
      completionSource: 'azitoctl',
      confidence: 'explicit',
    });
  });

  it('marks the turn failed when type is "fail"', () => {
    const turn = makeTurn();
    const turnRepo = makeTurnRepo(turn);
    const service = new AgentSignalService(turnRepo, hub, makeLogRepo(), makeAuditLogService());

    const result = service.handleSignal({ turnToken: buildTurnToken(turn), type: 'fail', reason: 'crashed' });

    expect(result.status).toBe(200);
    expect(turnRepo.markEnded).toHaveBeenCalledWith(turn.id, {
      status: 'failed',
      completionSource: 'azitoctl',
      confidence: 'explicit',
    });
  });

  it('does not change turn status when type is "progress"', () => {
    const turn = makeTurn();
    const turnRepo = makeTurnRepo(turn);
    const service = new AgentSignalService(turnRepo, hub, makeLogRepo(), makeAuditLogService());

    const result = service.handleSignal({ turnToken: buildTurnToken(turn), type: 'progress' });

    expect(result.status).toBe(200);
    expect(turnRepo.markEnded).not.toHaveBeenCalled();
    expect(turnRepo.appendEvent).toHaveBeenCalledWith(turn.id, expect.objectContaining({ type: 'progress' }));
  });

  it('appends a visibility log entry via logRepo when the turn has a unitId', () => {
    const turn = makeTurn({ unitId: 42 });
    const turnRepo = makeTurnRepo(turn);
    const logRepo = makeLogRepo();
    const service = new AgentSignalService(turnRepo, hub, logRepo, makeAuditLogService());

    service.handleSignal({ turnToken: buildTurnToken(turn), type: 'progress' });

    expect(logRepo.append).toHaveBeenCalledWith(turn.taskId, 42, 'command', expect.objectContaining({
      type: 'agent_signal_received',
      signalType: 'progress',
      turnId: turn.id,
    }));
  });

  it('skips the visibility log entry when the turn has no unitId', () => {
    const turn = makeTurn({ unitId: null });
    const turnRepo = makeTurnRepo(turn);
    const logRepo = makeLogRepo();
    const service = new AgentSignalService(turnRepo, hub, logRepo, makeAuditLogService());

    service.handleSignal({ turnToken: buildTurnToken(turn), type: 'progress' });

    expect(logRepo.append).not.toHaveBeenCalled();
  });

  it('emits the signal on TurnSignalHub for the resolved turn id', () => {
    const turn = makeTurn();
    const turnRepo = makeTurnRepo(turn);
    const service = new AgentSignalService(turnRepo, hub, makeLogRepo(), makeAuditLogService());
    const received: unknown[] = [];
    hub.subscribe(turn.id, (signal) => received.push(signal));

    service.handleSignal({ turnToken: buildTurnToken(turn), type: 'complete', testFailed: false, summary: 'done' });

    expect(received).toEqual([{ type: 'complete', testFailed: false, summary: 'done', output: undefined }]);
  });

  it('does not emit on the hub when the request is rejected (404)', () => {
    const turnRepo = makeTurnRepo(null);
    const service = new AgentSignalService(turnRepo, hub, makeLogRepo(), makeAuditLogService());
    const received: unknown[] = [];
    hub.subscribe(1, (signal) => received.push(signal));

    service.handleSignal({ turnToken: '10.1.nonce-1', type: 'progress' });

    expect(received).toHaveLength(0);
  });
});
