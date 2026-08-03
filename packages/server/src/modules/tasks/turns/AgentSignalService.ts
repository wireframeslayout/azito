import type { IExecutionLogRepository } from '../ExecutionLog';
import { parseTurnToken } from './AgentTurn';
import type { SqliteAgentTurnRepository } from './SqliteAgentTurnRepository';
import type { TurnSignalHub, TurnSignal } from './TurnSignalHub';

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
 * Handles the body of `POST /api/agent-signals` once the caller (route
 * handler) has already verified the shared bearer token. Resolves the turn
 * addressed by the request's `turnToken`, records the raw event, advances
 * the turn's terminal state where applicable, and republishes the signal on
 * `TurnSignalHub` for any subscribed `InProcessSignalStream`.
 */
export class AgentSignalService {
  constructor(
    private turnRepo: SqliteAgentTurnRepository,
    private turnSignalHub: TurnSignalHub,
    private logRepo: IExecutionLogRepository,
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

    if (!turn) {
      return { status: 404, body: { error: 'Turn not found' } };
    }

    if (turn.taskId !== parsed.taskId || turn.nonce !== parsed.nonce) {
      this.turnRepo.appendEvent(turn.id, {
        type: 'invalid',
        payload: JSON.stringify(rawBody),
        source: 'http',
      });
      return { status: 403, body: { error: 'Turn token does not match the resolved turn' } };
    }

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
