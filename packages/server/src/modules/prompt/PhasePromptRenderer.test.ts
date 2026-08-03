import { describe, it, expect } from 'vitest';
import { renderForStateMachine, renderForSkill } from './PhasePromptRenderer';

const SAMPLE_BODY = `Do the work.
After outputting the plan, report "PHASE_COMPLETE".
If you have questions, report them prefixed with "QUESTION:".
Echo QUESTIONS_JSON to signal structured questions.
If tests fail, report "TEST_FAILED: <details>".`;

const SM_OPTS = {
  phase: 'implementing' as const,
  capability: { questions: true, testFailed: false },
  doneMarker: 'AZITO_DONE_42_abc123',
  questionsMarker: 'AZITO_QUESTIONS_42_abc123',
  testFailedMarker: 'AZITO_TEST_FAILED_42_abc123',
  signalFilePath: '/tmp/azito-signal-42.txt',
  outputFilePath: '/tmp/azito-output-42-abc123.md',
};

describe('renderForStateMachine', () => {
  it('replaces PHASE_COMPLETE with doneMarker', () => {
    const result = renderForStateMachine(SAMPLE_BODY, SM_OPTS);
    expect(result).not.toContain('PHASE_COMPLETE');
    expect(result).toContain(SM_OPTS.doneMarker);
  });

  it('replaces QUESTIONS_JSON with questionsMarker', () => {
    const result = renderForStateMachine(SAMPLE_BODY, SM_OPTS);
    expect(result).not.toContain('QUESTIONS_JSON');
    expect(result).toContain(SM_OPTS.questionsMarker);
  });

  it('replaces TEST_FAILED with testFailedMarker', () => {
    const result = renderForStateMachine(SAMPLE_BODY, SM_OPTS);
    expect(result).not.toContain('TEST_FAILED:');
    expect(result).toContain(SM_OPTS.testFailedMarker);
  });

  it('appends completion_signal block with correct paths and markers', () => {
    const result = renderForStateMachine(SAMPLE_BODY, SM_OPTS);
    expect(result).toContain('<completion_signal>');
    expect(result).toContain(SM_OPTS.outputFilePath);
    expect(result).toContain(SM_OPTS.signalFilePath);
    expect(result).toContain(`echo "${SM_OPTS.doneMarker}" >> ${SM_OPTS.signalFilePath}`);
    expect(result).toContain(`echo '${SM_OPTS.questionsMarker}:`);
  });

  it('includes AZITO_PHASE_SUMMARY instruction with phase name', () => {
    const result = renderForStateMachine(SAMPLE_BODY, SM_OPTS);
    expect(result).toContain('AZITO_PHASE_SUMMARY:');
    expect(result).toContain(`"phase":"${SM_OPTS.phase}"`);
  });
});

describe('renderForSkill', () => {
  const SKILL_OPTS = { capability: { questions: true, testFailed: false } };

  it('does not contain AZITO_DONE markers', () => {
    const result = renderForSkill(SAMPLE_BODY, SKILL_OPTS);
    expect(result).not.toMatch(/AZITO_DONE/);
  });

  it('does not contain QUESTIONS_JSON marker', () => {
    const result = renderForSkill(SAMPLE_BODY, SKILL_OPTS);
    expect(result).not.toContain('QUESTIONS_JSON');
  });

  it('does not contain completion_signal block', () => {
    const result = renderForSkill(SAMPLE_BODY, SKILL_OPTS);
    expect(result).not.toContain('completion_signal');
  });

  it('does not contain echo commands with markers', () => {
    const result = renderForSkill(SAMPLE_BODY, SKILL_OPTS);
    expect(result).not.toMatch(/echo.*AZITO_/);
  });

  it('does not contain TEST_FAILED: marker prefix (verbatim)', () => {
    // The original "TEST_FAILED:" should be replaced with natural language
    const body = 'If tests fail, report "TEST_FAILED: details".';
    const result = renderForSkill(body, SKILL_OPTS);
    expect(result).not.toContain('TEST_FAILED:');
  });

  it('replaces PHASE_COMPLETE with natural language', () => {
    const result = renderForSkill(SAMPLE_BODY, SKILL_OPTS);
    expect(result).toContain('タスクが完了したら、その旨を報告してください');
  });

  it('replaces QUESTIONS_JSON with natural language', () => {
    const result = renderForSkill(SAMPLE_BODY, SKILL_OPTS);
    expect(result).toContain('質問がある場合は、明確に質問してください');
  });

  it('replaces TEST_FAILED: with natural language', () => {
    const result = renderForSkill(SAMPLE_BODY, SKILL_OPTS);
    expect(result).toContain('テストが失敗した場合は、その内容を報告してください:');
  });

  it('appends nextPhaseSkill recommendation when provided', () => {
    const result = renderForSkill(SAMPLE_BODY, { ...SKILL_OPTS, nextPhaseSkillCommand: 'azt-implement' });
    expect(result).toContain('`/azt-implement`');
    expect(result).toContain('完了したら次に');
  });

  it('does not append recommendation when nextPhaseSkill is not provided', () => {
    const result = renderForSkill(SAMPLE_BODY, SKILL_OPTS);
    expect(result).not.toContain('/azt-');
  });

  it('appends the questions capability sentence for a questions-capable phase', () => {
    const result = renderForSkill(SAMPLE_BODY, { capability: { questions: true, testFailed: false } });
    expect(result).toContain('ユーザーに直接質問してください');
  });

  it('does not append the questions capability sentence for a non-questions phase', () => {
    const result = renderForSkill(SAMPLE_BODY, { capability: { questions: false, testFailed: false } });
    expect(result).not.toContain('不明点や確認したいことがあれば');
  });

  it('appends the test-failed capability sentence only for the testing phase', () => {
    const result = renderForSkill(SAMPLE_BODY, { capability: { questions: false, testFailed: true } });
    expect(result).toContain('テストが失敗した場合は、その内容を報告してください。');
  });
});
