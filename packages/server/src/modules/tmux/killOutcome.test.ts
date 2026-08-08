import { describe, it, expect } from 'vitest';
import { resolveKillOutcome } from './killOutcome';
import type { ExecResult } from '../servers/transport/ServerTransport';

describe('resolveKillOutcome', () => {
  it('reports success for a clean exit (code 0)', async () => {
    const result: ExecResult = { stdout: '', stderr: '', code: 0 };
    const outcome = await resolveKillOutcome(Promise.resolve(result));
    expect(outcome).toEqual({ success: true, alreadyGone: false, result });
  });

  it('classifies "can\'t find window" as alreadyGone (kill-window wording)', async () => {
    const result: ExecResult = { stdout: '', stderr: "can't find window: foo", code: 1 };
    const outcome = await resolveKillOutcome(Promise.resolve(result));
    expect(outcome.success).toBe(true);
    expect(outcome.alreadyGone).toBe(true);
  });

  it('classifies "no such session" as alreadyGone (kill-session wording)', async () => {
    const result: ExecResult = { stdout: '', stderr: 'no such session: foo', code: 1 };
    const outcome = await resolveKillOutcome(Promise.resolve(result));
    expect(outcome.success).toBe(true);
    expect(outcome.alreadyGone).toBe(true);
  });

  it('classifies "no server running" as alreadyGone when the ExecResult resolves with a non-zero code', async () => {
    const result: ExecResult = { stdout: '', stderr: 'no server running on /tmp/tmux-1000/default', code: 1 };
    const outcome = await resolveKillOutcome(Promise.resolve(result));
    expect(outcome.success).toBe(true);
    expect(outcome.alreadyGone).toBe(true);
  });

  it('classifies "no server running" as alreadyGone when the exec promise rejects (local transport)', async () => {
    const outcome = await resolveKillOutcome(
      Promise.reject(new Error('Command failed: tmux kill-window -t foo\nno server running on /tmp/tmux-1000/default\n')),
    );
    expect(outcome.success).toBe(true);
    expect(outcome.alreadyGone).toBe(true);
  });

  it('classifies "no server running" reported via stdout as alreadyGone too', async () => {
    const result: ExecResult = { stdout: 'no server running', stderr: '', code: 1 };
    const outcome = await resolveKillOutcome(Promise.resolve(result));
    expect(outcome.success).toBe(true);
    expect(outcome.alreadyGone).toBe(true);
  });

  it('treats an unrelated non-zero exit as a real failure', async () => {
    const result: ExecResult = { stdout: '', stderr: 'some other tmux error', code: 1 };
    const outcome = await resolveKillOutcome(Promise.resolve(result));
    expect(outcome.success).toBe(false);
    expect(outcome.alreadyGone).toBe(false);
  });

  it('treats an unrelated rejection as a real failure', async () => {
    const outcome = await resolveKillOutcome(Promise.reject(new Error('ECONNREFUSED')));
    expect(outcome.success).toBe(false);
    expect(outcome.alreadyGone).toBe(false);
  });
});
