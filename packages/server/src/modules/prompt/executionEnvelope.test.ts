import { describe, it, expect } from 'vitest';
import { stateMachineEnvelope, skillEnvelope, httpSignalEnvelope, FOLLOW_UP_CAPABILITY } from './executionEnvelope';
import type { PhaseSignalCapability } from './executionEnvelope';
import type { TaskPhase } from '../sidekicks/TaskPhase';

const SM_BASE = {
  doneMarker: 'AZITO_DONE_1_abc',
  questionsMarker: 'AZITO_QUESTIONS_1_abc',
  testFailedMarker: 'AZITO_TEST_FAILED_1_abc',
  signalFilePath: '/tmp/azito-signal-1.txt',
  outputFilePath: '/tmp/azito-output-1-abc.md',
};

const HTTP_BASE = {
  turnToken: 'turn-abc123',
  azitoctlPath: '/usr/local/bin/azitoctl',
  outputFilePath: '/tmp/azito-output-1-abc.md',
};

describe('stateMachineEnvelope', () => {
  it('always includes the done-marker echo and AZITO_PHASE_SUMMARY instruction, even with an empty body', () => {
    const result = stateMachineEnvelope({ phase: 'reviewing', capability: { questions: false, testFailed: false }, ...SM_BASE }).wrap('');
    expect(result).toContain('<completion_signal>');
    expect(result).toContain(SM_BASE.outputFilePath);
    expect(result).toContain('AZITO_PHASE_SUMMARY:');
    expect(result).toContain('"phase":"reviewing"');
    expect(result).toContain(`echo "${SM_BASE.doneMarker}" >> ${SM_BASE.signalFilePath}`);
  });

  it('includes the questions section for a questions-capable phase (implementing)', () => {
    const result = stateMachineEnvelope({ phase: 'implementing', capability: { questions: true, testFailed: false }, ...SM_BASE }).wrap('body');
    expect(result).toContain(`echo '${SM_BASE.questionsMarker}:`);
  });

  it('omits the questions section for testing (not questions-capable)', () => {
    const result = stateMachineEnvelope({ phase: 'testing', capability: { questions: false, testFailed: true }, ...SM_BASE }).wrap('body');
    expect(result).not.toContain(SM_BASE.questionsMarker);
  });

  it('includes the test-failed section only for testing', () => {
    const result = stateMachineEnvelope({ phase: 'testing', capability: { questions: false, testFailed: true }, ...SM_BASE }).wrap('body');
    expect(result).toContain(SM_BASE.testFailedMarker);
  });

  it('omits the test-failed section for planning (not test-failed-capable)', () => {
    const result = stateMachineEnvelope({ phase: 'planning', capability: { questions: true, testFailed: false }, ...SM_BASE }).wrap('body');
    expect(result).not.toContain(SM_BASE.testFailedMarker);
  });

  it('omits both questions and test-failed sections for reviewing/pushing', () => {
    for (const phase of ['reviewing', 'pushing'] as const) {
      const result = stateMachineEnvelope({ phase, capability: { questions: false, testFailed: false }, ...SM_BASE }).wrap('body');
      expect(result).not.toContain(SM_BASE.questionsMarker);
      expect(result).not.toContain(SM_BASE.testFailedMarker);
    }
  });

  it('supports phase: "follow_up" (questions-capable, not test-failed-capable, like planning/implementing)', () => {
    const result = stateMachineEnvelope({ phase: 'follow_up', capability: FOLLOW_UP_CAPABILITY, ...SM_BASE }).wrap('body');
    expect(result).toContain('"phase":"follow_up"');
    expect(result).toContain(`echo '${SM_BASE.questionsMarker}:`);
    expect(result).not.toContain(SM_BASE.testFailedMarker);
  });

  it('snapshots the full completion_signal block for every TaskPhase', () => {
    for (const phase of ['planning', 'implementing', 'reviewing', 'testing', 'pushing'] as const) {
      const result = stateMachineEnvelope({ phase, capability: { questions: true, testFailed: true }, ...SM_BASE }).wrap('body');
      expect(result).toMatchSnapshot(phase);
    }
  });

  it('snapshots the full completion_signal block for follow_up', () => {
    const result = stateMachineEnvelope({ phase: 'follow_up', capability: FOLLOW_UP_CAPABILITY, ...SM_BASE }).wrap('');
    expect(result).toMatchSnapshot('follow_up');
  });
});

describe('httpSignalEnvelope', () => {
  it('always includes the STEP 1 output-file + AZITO_PHASE_SUMMARY block, identical in shape to stateMachineEnvelope', () => {
    const result = httpSignalEnvelope({ phase: 'reviewing', capability: { questions: false, testFailed: false }, ...HTTP_BASE }).wrap('');
    expect(result).toContain('<completion_signal>');
    expect(result).toContain(HTTP_BASE.outputFilePath);
    expect(result).toContain('AZITO_PHASE_SUMMARY:');
    expect(result).toContain('"phase":"reviewing"');
  });

  it('STEP 2 runs azitoctl complete with the turn token and output file', () => {
    const result = httpSignalEnvelope({ phase: 'reviewing', capability: { questions: false, testFailed: false }, ...HTTP_BASE }).wrap('body');
    expect(result).toContain(
      `${HTTP_BASE.azitoctlPath} complete --turn ${HTTP_BASE.turnToken} --output-file ${HTTP_BASE.outputFilePath}`,
    );
  });

  it('includes the questions command for a questions-capable phase (planning/implementing) and null (follow-up)', () => {
    for (const phase of ['planning', 'implementing', null] as (TaskPhase | null)[]) {
      const result = httpSignalEnvelope({ phase, capability: { questions: true, testFailed: false }, ...HTTP_BASE }).wrap('body');
      expect(result).toContain(`${HTTP_BASE.azitoctlPath} questions --turn ${HTTP_BASE.turnToken}`);
      expect(result).toContain(phase === null ? '"phase":"follow_up"' : `"phase":"${phase}"`);
    }
  });

  it('omits the questions command for reviewing/pushing/testing', () => {
    for (const phase of ['reviewing', 'pushing', 'testing'] as TaskPhase[]) {
      const capability: PhaseSignalCapability = phase === 'testing'
        ? { questions: false, testFailed: true }
        : { questions: false, testFailed: false };
      const result = httpSignalEnvelope({ phase, capability, ...HTTP_BASE }).wrap('body');
      expect(result).not.toContain('questions --turn');
    }
  });

  it('includes the --test-failed complete command only for testing', () => {
    const result = httpSignalEnvelope({ phase: 'testing', capability: { questions: false, testFailed: true }, ...HTTP_BASE }).wrap('body');
    expect(result).toContain(
      `${HTTP_BASE.azitoctlPath} complete --turn ${HTTP_BASE.turnToken} --test-failed --output-file ${HTTP_BASE.outputFilePath}`,
    );
  });

  it('omits the --test-failed command for non-testing phases', () => {
    for (const phase of ['planning', 'implementing', 'reviewing', 'pushing', null] as (TaskPhase | null)[]) {
      const capability: PhaseSignalCapability = (phase === 'planning' || phase === 'implementing' || phase === null)
        ? { questions: true, testFailed: false }
        : { questions: false, testFailed: false };
      const result = httpSignalEnvelope({ phase, capability, ...HTTP_BASE }).wrap('body');
      expect(result).not.toContain('--test-failed');
    }
  });

  it('never emits shell echo markers or a signal file path (uses azitoctl instead)', () => {
    const result = httpSignalEnvelope({ phase: 'implementing', capability: { questions: true, testFailed: false }, ...HTTP_BASE }).wrap('body');
    expect(result).not.toMatch(/echo .*AZITO_(DONE|QUESTIONS|TEST_FAILED)/);
  });
});

describe('skillEnvelope', () => {
  it('always appends a natural-language completion instruction', () => {
    const result = skillEnvelope({ capability: { questions: false, testFailed: false } }).wrap('body');
    expect(result).toContain('タスクが完了したら、その旨を報告してください。');
  });

  it('appends the questions sentence for planning/implementing only', () => {
    expect(skillEnvelope({ capability: { questions: true, testFailed: false } }).wrap('body')).toContain('ユーザーに直接質問してください');
    expect(skillEnvelope({ capability: { questions: false, testFailed: false } }).wrap('body')).not.toContain('ユーザーに直接質問してください');
  });

  it('appends the test-failed sentence for testing only', () => {
    expect(skillEnvelope({ capability: { questions: false, testFailed: true } }).wrap('body')).toContain('テストが失敗した場合は、その内容を報告してください。');
    expect(skillEnvelope({ capability: { questions: true, testFailed: false } }).wrap('body')).not.toContain('テストが失敗した場合は');
  });

  it('appends the nextPhaseSkill hint when provided', () => {
    const result = skillEnvelope({ capability: { questions: true, testFailed: false }, nextPhaseSkillCommand: 'azt-implement' }).wrap('body');
    expect(result).toContain('`/azt-implement`');
  });

  it('does not append a nextPhaseSkill hint when not provided', () => {
    const result = skillEnvelope({ capability: { questions: true, testFailed: false } }).wrap('body');
    expect(result).not.toContain('/azt-');
  });

  it('never emits machine markers or a completion_signal block', () => {
    const result = skillEnvelope({ capability: { questions: true, testFailed: false }, nextPhaseSkillCommand: 'azt-review' }).wrap('body');
    expect(result).not.toMatch(/AZITO_DONE|AZITO_QUESTIONS|AZITO_TEST_FAILED/);
    expect(result).not.toContain('completion_signal');
  });
});
