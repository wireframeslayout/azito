import { describe, it, expect } from 'vitest';
import { stateMachineEnvelope, skillEnvelope, httpSignalEnvelope, questionsFileFor, FOLLOW_UP_CAPABILITY } from './executionEnvelope';
import type { PhaseSignalCapability } from './executionEnvelope';
import type { TaskPhase } from '../sidekicks/TaskPhase';

const SM_BASE = {
  doneMarker: 'AZITO_DONE_1_abc',
  questionsMarker: 'AZITO_QUESTIONS_1_abc',
  testFailedMarker: 'AZITO_TEST_FAILED_1_abc',
  signalFilePath: '/tmp/azito-signal-1.txt',
  host: { os: 'posix' as const, azitoctl: '/usr/local/bin/azitoctl' },
  outputFilePath: '/tmp/azito-output-1-abc.md',
};

const HTTP_BASE = {
  turnToken: 'turn-abc123',
  host: { os: 'posix' as const, azitoctl: '/usr/local/bin/azitoctl' },
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
      `${HTTP_BASE.host.azitoctl} complete --turn ${HTTP_BASE.turnToken} --output-file ${HTTP_BASE.outputFilePath}`,
    );
  });

  it('includes the questions command for a questions-capable phase (planning/implementing) and null (follow-up)', () => {
    for (const phase of ['planning', 'implementing', null] as (TaskPhase | null)[]) {
      const result = httpSignalEnvelope({ phase, capability: { questions: true, testFailed: false }, ...HTTP_BASE }).wrap('body');
      expect(result).toContain(`${HTTP_BASE.host.azitoctl} questions --turn ${HTTP_BASE.turnToken}`);
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
      `${HTTP_BASE.host.azitoctl} complete --turn ${HTTP_BASE.turnToken} --test-failed --output-file ${HTTP_BASE.outputFilePath}`,
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

describe('envelopes for a Windows host (#371): no shell syntax, azitoctl.mjs and quoted forward-slash paths', () => {
  const host = { os: 'windows' as const, azitoctl: 'node "C:/Users/me/.azito/harness/bin/azitoctl.mjs"' };
  const WIN_SM = {
    doneMarker: 'AZITO_DONE_1_abc',
    questionsMarker: 'AZITO_QUESTIONS_1_abc',
    testFailedMarker: 'AZITO_TEST_FAILED_1_abc',
    signalFilePath: 'C:\\Users\\me\\AppData\\Local\\Temp\\azito-pipe-1-sig-9.log',
    outputFilePath: 'C:\\Users\\me\\AppData\\Local\\Temp\\azito-output-1-abc.md',
    host,
  };
  // Nothing a shell has to interpret: no here-document, no redirection, no echo, no backslash path.
  const expectNoShellSyntax = (text: string): void => {
    expect(text).not.toMatch(/<<|>>|^\s*cat\s|\becho\b/m);
    expect(text).not.toContain('\\Users');
  };

  it('state machine: writes the output with the file-writing tool and signals with azitoctl.mjs signal', () => {
    const result = stateMachineEnvelope({ phase: 'planning', capability: { questions: false, testFailed: false }, ...WIN_SM }).wrap('body');
    expectNoShellSyntax(result);
    expect(result).toContain('to the file "C:/Users/me/AppData/Local/Temp/azito-output-1-abc.md" as UTF-8 text');
    expect(result).toContain('"phase":"planning"');
    expect(result).toContain(`${host.azitoctl} signal --file "C:/Users/me/AppData/Local/Temp/azito-pipe-1-sig-9.log" --marker AZITO_DONE_1_abc`);
    expect(result).toContain(`${host.azitoctl} output --file "C:/Users/me/AppData/Local/Temp/azito-output-1-abc.md"`);
    expect(result).not.toContain('--json-file');
  });

  it('state machine: questions go through a JSON file next to the output file', () => {
    const result = stateMachineEnvelope({ phase: 'implementing', capability: { questions: true, testFailed: false }, ...WIN_SM }).wrap('body');
    expectNoShellSyntax(result);
    expect(result).toContain('"C:/Users/me/AppData/Local/Temp/azito-output-1-abc.md.questions.json"');
    expect(result).toContain(`${host.azitoctl} signal --file "C:/Users/me/AppData/Local/Temp/azito-pipe-1-sig-9.log" --marker AZITO_QUESTIONS_1_abc --json-file "C:/Users/me/AppData/Local/Temp/azito-output-1-abc.md.questions.json"`);
    expect(questionsFileFor(WIN_SM.outputFilePath)).toBe(`${WIN_SM.outputFilePath}.questions.json`);
  });

  it('state machine: the test-failed section is the same text as on POSIX', () => {
    const result = stateMachineEnvelope({ phase: 'testing', capability: { questions: false, testFailed: true }, ...WIN_SM }).wrap('body');
    expect(result).toContain('prefixed with "AZITO_TEST_FAILED_1_abc:"');
  });

  it('http-signal: complete / questions / test-failed through azitoctl.mjs with quoted paths', () => {
    const base = { turnToken: 'turn-abc123', outputFilePath: WIN_SM.outputFilePath, host };
    const planning = httpSignalEnvelope({ phase: 'planning', capability: { questions: true, testFailed: false }, ...base }).wrap('body');
    expectNoShellSyntax(planning);
    expect(planning).toContain(`${host.azitoctl} complete --turn turn-abc123 --output-file "C:/Users/me/AppData/Local/Temp/azito-output-1-abc.md"`);
    expect(planning).toContain(`${host.azitoctl} questions --turn turn-abc123 --json-file "C:/Users/me/AppData/Local/Temp/azito-output-1-abc.md.questions.json"`);
    const testing = httpSignalEnvelope({ phase: 'testing', capability: { questions: false, testFailed: true }, ...base }).wrap('body');
    expect(testing).toContain(`${host.azitoctl} complete --turn turn-abc123 --test-failed --output-file "C:/Users/me/AppData/Local/Temp/azito-output-1-abc.md"`);
    expect(httpSignalEnvelope({ phase: null, capability: { questions: false, testFailed: false }, ...base }).wrap('')).toContain('"phase":"follow_up"');
  });

  it('refuses a path a double-quoted word would read as more than text', () => {
    for (const bad of ['C:\\Users\\jo$e\\Temp\\out.md', 'C:\\Users\\a`b\\Temp\\out.md', 'C:\\Users\\a"b\\Temp\\out.md']) {
      expect(() => stateMachineEnvelope({ phase: 'planning', capability: { questions: false, testFailed: false }, ...WIN_SM, outputFilePath: bad }).wrap('x')).toThrow(/double quote, \$ or a backtick/);
    }
  });

  it('keeps a space and non-ASCII characters in a path (they are inside the quotes)', () => {
    const result = httpSignalEnvelope({ phase: 'planning', capability: { questions: false, testFailed: false }, turnToken: 't', host, outputFilePath: 'C:\\Users\\山田 太郎\\Temp\\out.md' }).wrap('');
    expect(result).toContain('--output-file "C:/Users/山田 太郎/Temp/out.md"');
  });
});
