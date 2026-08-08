import type { IExecutionLogRepository } from '../ExecutionLog';
import { parseTurnToken } from './AgentTurn';
import type { SqliteAgentTurnRepository } from './SqliteAgentTurnRepository';
import type { TurnSignalHub, TurnSignal } from './TurnSignalHub';
import type { AuditLogService } from '../../../shared/audit/AuditLogService';

const MAX_OUTPUT_BYTES = 256 * 1024;

export interface SignalHandlerResult {
  status: number;
  body: Record<string, unknown>;
}

type SignalType = 'complete' | 'questions' | 'fail' | 'progress';

interface ValidatedSignalBody {
  turnToken: string;
  type: SignalType;
  testFailed?: boolean;
  summary?: string;
  output?: string;
  questions?: unknown[];
  reason?: string;
}

function truncateOutput(output: string): string {
  const bytes = Buffer.byteLength(output, 'utf-8');
  if (bytes <= MAX_OUTPUT_BYTES) return output;
  return Buffer.from(output, 'utf-8').subarray(0, MAX_OUTPUT_BYTES).toString('utf-8');
}

/** Validates raw request body shape. Returns an error message on the first violation found. */
function validateBody(raw: unknown): { value: ValidatedSignalBody } | { error: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'JSON object body required' };
  }
  const body = raw as Record<string, unknown>;

  if (typeof body.turnToken !== 'string' || body.turnToken === '') {
    return { error: 'turnToken must be a non-empty string' };
  }
  if (parseTurnToken(body.turnToken) === null) {
    return { error: 'turnToken has an invalid format' };
  }
  if (body.type !== 'complete' && body.type !== 'questions' && body.type !== 'fail' && body.type !== 'progress') {
    return { error: 'type must be one of "complete", "questions", "fail", "progress"' };
  }
  const type = body.type;

  if (body.summary !== undefined && typeof body.summary !== 'string') {
    return { error: 'summary must be a string' };
  }
  if (body.output !== undefined && typeof body.output !== 'string') {
    return { error: 'output must be a string' };
  }

  // azitoctl only includes testFailed when the --test-failed flag is set;
  // a plain completion omits the field entirely and means "tests passed".
  if (body.testFailed !== undefined && typeof body.testFailed !== 'boolean') {
    return { error: 'testFailed must be a boolean' };
  }
  if (type === 'questions' && !Array.isArray(body.questions)) {
    return { error: 'questions must be an array when type is "questions"' };
  }
  if (body.reason !== undefined && typeof body.reason !== 'string') {
    return { error: 'reason must be a string' };
  }

  return {
    value: {
      turnToken: body.turnToken,
      type,
      testFailed: type === 'complete' ? (typeof body.testFailed === 'boolean' ? body.testFailed : false) : undefined,
      summary: typeof body.summary === 'string' ? body.summary : undefined,
      output: typeof body.output === 'string' ? truncateOutput(body.output) : undefined,
      questions: Array.isArray(body.questions) ? body.questions : undefined,
      reason: typeof body.reason === 'string' ? body.reason : undefined,
    },
  };
}

function toTurnSignal(value: ValidatedSignalBody): TurnSignal {
  switch (value.type) {
    case 'complete':
      // validateBody normalizes testFailed to a boolean (defaults to false) for this type.
      return { type: 'complete', testFailed: value.testFailed ?? false, summary: value.summary, output: value.output };
    case 'questions':
      // questions is guaranteed an array by validateBody for this type.
      return { type: 'questions', questions: value.questions as unknown[] };
    case 'fail':
      return { type: 'fail', reason: value.reason };
    case 'progress':
      return { type: 'progress' };
  }
}

/**
 * Handles the body of `POST /api/agent-signals`. The route handler
 * (agentSignalRoutes.ts) checks the shared bearer token only for audit
 * purposes (design v3 §8) — it is not required, since a valid `turnToken`
 * alone is sufficient proof of identity (see that file's doc comment). This
 * class is therefore the actual point of authentication: it resolves the
 * turn addressed by the request's `turnToken` and verifies it matches
 * (taskId + nonce) BEFORE touching the database (Issue #28 third-party
 * review, Important finding — see the `!turn`/mismatch branches below for
 * why persistence must never happen ahead of that check). Only once
 * authenticated does it record the raw event, advance the turn's terminal
 * state where applicable, and republish the signal on `TurnSignalHub` for
 * any subscribed `InProcessSignalStream`.
 */
export class AgentSignalService {
  constructor(
    private turnRepo: SqliteAgentTurnRepository,
    private turnSignalHub: TurnSignalHub,
    private logRepo: IExecutionLogRepository,
    private auditLogService: AuditLogService,
  ) {}

  handleSignal(rawBody: unknown): SignalHandlerResult {
    const validated = validateBody(rawBody);
    if ('error' in validated) {
      return { status: 400, body: { error: validated.error } };
    }
    const { value } = validated;

    // Format already checked in validateBody; parseTurnToken cannot return null here.
    const parsed = parseTurnToken(value.turnToken)!;
    const turn = this.turnRepo.findById(parsed.turnId);

    // Authentication (turn exists + taskId/nonce match) runs to completion
    // BEFORE any persistence side effect (Issue #28 third-party review,
    // Important finding): this used to call `this.turnRepo.appendEvent(...)`
    // — writing the full request body (up to MAX_EVENT_PAYLOAD_BYTES, 256KiB)
    // into `agent_turn_events` — for a turnToken that merely resolved a
    // turnId but failed the taskId/nonce match, before returning 403. An
    // unauthenticated caller could brute-force turnIds (small sequential
    // integers) and grow `agent_turn_events` without bound, each row costing
    // up to 256KiB. Neither branch below writes anything to `agent_turns`/
    // `agent_turn_events`; the only record of a failed credential is the
    // flood-suppressed, metadata-only `auditLogService.record()` call
    // (AuditLogService already collapses identical repeats within its own
    // window — see its doc comment — so a caller hammering the SAME invalid
    // turnToken doesn't grow audit_log unbounded either; a caller trying
    // many DISTINCT turnIds still gets one small metadata row per attempt,
    // never a 256KiB body).
    if (!turn) {
      this.auditLogService.record({
        actorClass: 'runtime',
        actorId: null,
        event: 'agent_signal.rejected',
        detail: { reason: 'turn_not_found' },
      });
      return { status: 404, body: { error: 'Turn not found' } };
    }

    if (turn.taskId !== parsed.taskId || turn.nonce !== parsed.nonce) {
      this.auditLogService.record({
        actorClass: 'runtime',
        actorId: null,
        event: 'agent_signal.rejected',
        detail: { reason: 'turn_mismatch', turnId: turn.id },
      });
      return { status: 403, body: { error: 'Turn token does not match the resolved turn' } };
    }

    // Everything below this point only runs once the turnToken has actually
    // authenticated against a resolved turn — no persistence above this line.
    if (turn.status !== 'running') {
      this.turnRepo.appendEvent(turn.id, {
        type: 'duplicate',
        payload: JSON.stringify(rawBody),
        source: 'http',
      });
      return { status: 200, body: { ok: true, duplicate: true } };
    }

    this.turnRepo.appendEvent(turn.id, {
      type: value.type,
      payload: JSON.stringify(rawBody),
      source: 'http',
    });

    if (value.type !== 'progress') {
      const status = value.type === 'complete' ? (value.testFailed ? 'test_failed' : 'completed')
        : value.type === 'questions' ? 'questions'
        : 'failed';
      this.turnRepo.markEnded(turn.id, {
        status,
        completionSource: 'azitoctl',
        confidence: 'explicit',
      });
    }

    // Best-effort execution_log visibility. Only written when a unitId is
    // resolvable — execution_log.unit_id is NOT NULL and this row is a
    // secondary visibility trail, not something the caller depends on.
    if (turn.unitId !== null) {
      this.logRepo.append(turn.taskId, turn.unitId, 'command', {
        type: 'agent_signal_received',
        signalType: value.type,
        turnId: turn.id,
      });
    }

    this.turnSignalHub.emitSignal(turn.id, toTurnSignal(value));

    return { status: 200, body: { ok: true } };
  }
}
