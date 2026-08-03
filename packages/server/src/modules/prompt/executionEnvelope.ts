/**
 * Execution envelope abstraction (Issue #263 Refine D).
 *
 * A Sidekick body (SKILL.md) describes *capability* — what the agent should
 * do for a phase. It must not itself encode the *execution protocol* — how
 * completion/questions/test-failure get signaled back to whatever process is
 * driving the agent. That protocol differs entirely by execution context:
 *
 *  - state-machine (PhaseLoopRunner): a headless worker pane monitored via
 *    tmux pipe-pane + a signal file. Needs machine-parseable markers
 *    (AZITO_DONE_*, AZITO_QUESTIONS_*, AZITO_TEST_FAILED_*) and a structured
 *    AZITO_PHASE_SUMMARY line so WorkerWaiter/PhaseLoopRunner can detect
 *    completion and extract a summary programmatically.
 *  - skill (RenderSkillPromptUseCase / harness azt-* skills): an interactive
 *    Claude Code session. "Protocol" here is just natural language — report
 *    completion, ask the user directly, mention the next skill to run.
 *  - standalone (GET /api/sidekicks/:name?render=1, used by /azt-sidekick):
 *    no execution context at all. No envelope is applied — the body renders
 *    exactly as authored, with no signal-protocol text leaking into a
 *    context where nothing is listening for it.
 *
 * Each execution context builds its own envelope directly (state machine ->
 * stateMachineEnvelope, skill -> skillEnvelope) — there is intentionally no
 * envelope registry/lookup here. The two shapes are too different (shell
 * marker instructions vs. natural language) to be usefully unified beyond
 * the shared `wrap` entry point. Adding a third execution process later
 * (e.g. wrapping the LLM orchestrator loop) means adding a third
 * `xxxEnvelope()` factory to this file, not extending its public surface.
 */
export interface ExecutionEnvelope {
  /** Returns `body` with the execution protocol for this context appended. */
  wrap(body: string): string;
}

/** Which out-of-band signals a phase's envelope needs to support. */
export interface PhaseSignalCapability {
  questions: boolean;
  testFailed: boolean;
}

/** Follow-up (no fixed phase) always supports questions, never test-failed. */
export const FOLLOW_UP_CAPABILITY: PhaseSignalCapability = { questions: true, testFailed: false };

/**
 * A phase label used in the STEP 1 output file's AZITO_PHASE_SUMMARY line.
 * `'follow_up'` covers the follow-up execution context (ExecuteTaskUseCase.followUp),
 * which runs outside the phase state machine and therefore has no phase of its own.
 */
type PhaseLabel = string | 'follow_up';

/**
 * Renders STEP 1 of the completion_signal block: writing the phase's full output
 * (plus the machine-parseable AZITO_PHASE_SUMMARY trailer) to outputFilePath.
 * Shared verbatim between stateMachineEnvelope and httpSignalEnvelope — both
 * execution contexts write the same output file in the same format; only STEP 2
 * (how completion is *signaled*) differs between them.
 */
function buildStep1Block(outputFilePath: string, phase: PhaseLabel): string {
  return `STEP 1 — Write your complete final output for this phase (the deliverable described in the <output> section, e.g. the full implementation plan in markdown) to the file ${outputFilePath} by running:
  cat > ${outputFilePath} <<'AZITO_EOF'
  ...your complete output here...

AZITO_PHASE_SUMMARY: {"phase":"${phase}","status":"completed","summary":"<1-2 sentence summary of what was done in this phase>","tokensUsed":{"input":<estimated_input_tokens>,"output":<estimated_output_tokens>},"durationSeconds":<estimated_seconds>}
AZITO_EOF

Important: The AZITO_PHASE_SUMMARY line must be the LAST line in the file, after all your output. Replace the placeholder values with your best estimates.`;
}

export interface StateMachineEnvelopeOpts {
  /** `'follow_up'` for the follow-up execution context, which has no phase of its own. */
  phase: PhaseLabel;
  capability: PhaseSignalCapability;
  doneMarker: string;
  questionsMarker: string;
  testFailedMarker: string;
  signalFilePath: string;
  outputFilePath: string;
}

/**
 * Envelope for the state-machine execution context (PhaseLoopRunner), and for the
 * follow-up execution context (ExecuteTaskUseCase.followUp, `phase: 'follow_up'`) —
 * follow-up drives the same tmux pane + signal-file mechanism as a phase, so it
 * reuses this envelope rather than hand-rolling its own completion_signal block.
 *
 * The envelope alone is a complete contract: even a body with no legacy
 * PHASE_COMPLETE/QUESTIONS_JSON/TEST_FAILED tokens at all still gets full
 * completion/question/test-failure instructions from this block.
 */
export function stateMachineEnvelope(opts: StateMachineEnvelopeOpts): ExecutionEnvelope {
  const { phase, capability, doneMarker, questionsMarker, testFailedMarker, signalFilePath, outputFilePath } = opts;

  const questionsSection = capability.questions
    ? `

If instead you need to ask the user questions, skip both steps above and run (single-quote the JSON; use "select" type with options when choices are enumerable, "text" otherwise):
  echo '${questionsMarker}: [{"text":"...","type":"select","options":["A","B"]}]' >> ${signalFilePath}
Output ALL questions at once in a single line. Do NOT use interactive prompts or selection UIs — write the line above and then stop.`
    : '';

  const testFailedSection = capability.testFailed
    ? `

If tests fail, report the failures prefixed with "${testFailedMarker}:" in your output for STEP 1 above, then continue with STEP 2 as usual.`
    : '';

  return {
    wrap(body: string): string {
      const completionSignalBlock = `\n\n<completion_signal>
When you finish this phase, do BOTH steps in order:

${buildStep1Block(outputFilePath, phase)}

STEP 2 — Then, as the VERY LAST action, run:
  echo "${doneMarker}" >> ${signalFilePath}${questionsSection}${testFailedSection}
</completion_signal>`;
      return body + completionSignalBlock;
    },
  };
}

export interface HttpSignalEnvelopeOpts {
  /** Phase label for the AZITO_PHASE_SUMMARY line. null for follow-up. */
  phase: string | null;
  capability: PhaseSignalCapability;
  turnToken: string;
  /** Absolute path to the azitoctl CLI on the target environment. */
  azitoctlPath: string;
  outputFilePath: string;
}

/**
 * Envelope for the http-signal execution context: instead of writing markers to a
 * signal file (echo ... >> signalFilePath), the agent reports completion/questions/
 * test-failure to the hub via HTTP POST through the `azitoctl` CLI. STEP 1 (writing
 * the phase output file + AZITO_PHASE_SUMMARY) is identical to stateMachineEnvelope
 * — only STEP 2 and the questions/test-failed commands differ.
 */
export function httpSignalEnvelope(opts: HttpSignalEnvelopeOpts): ExecutionEnvelope {
  const { phase, capability, turnToken, azitoctlPath, outputFilePath } = opts;
  const phaseLabel: PhaseLabel = phase ?? 'follow_up';

  const questionsSection = capability.questions
    ? `

If instead you need to ask the user questions, skip both steps above and run (single-quote the JSON; use "select" type with options when choices are enumerable, "text" otherwise):
  ${azitoctlPath} questions --turn ${turnToken} '[{"text":"...","type":"select","options":["A","B"]}]'
Output ALL questions at once in a single invocation. Do NOT use interactive prompts or selection UIs — run the command above and then stop.`
    : '';

  const testFailedSection = capability.testFailed
    ? `

If tests fail, report the failures in your output for STEP 1 above, then instead of the STEP 2 command, run:
  ${azitoctlPath} complete --turn ${turnToken} --test-failed --output-file ${outputFilePath}`
    : '';

  return {
    wrap(body: string): string {
      const completionSignalBlock = `\n\n<completion_signal>
When you finish this phase, do BOTH steps in order:

${buildStep1Block(outputFilePath, phaseLabel)}

STEP 2 — Then, as the VERY LAST action, run:
  ${azitoctlPath} complete --turn ${turnToken} --output-file ${outputFilePath}${questionsSection}${testFailedSection}
</completion_signal>`;
      return body + completionSignalBlock;
    },
  };
}

export interface SkillEnvelopeOpts {
  capability: PhaseSignalCapability;
  /** Skill command for the next phase (e.g. 'azt-implement'). */
  nextPhaseSkillCommand?: string;
}

/**
 * Envelope for the skill execution context (RenderSkillPromptUseCase / harness
 * azt-* skills) — an interactive Claude Code session, so the protocol is
 * natural language rather than machine markers.
 */
export function skillEnvelope(opts: SkillEnvelopeOpts): ExecutionEnvelope {
  const { capability } = opts;

  return {
    wrap(body: string): string {
      const lines = [body, '', 'タスクが完了したら、その旨を報告してください。'];
      if (capability.questions) {
        lines.push('不明点や確認したいことがあれば、ユーザーに直接質問してください。');
      }
      if (capability.testFailed) {
        lines.push('テストが失敗した場合は、その内容を報告してください。');
      }
      if (opts.nextPhaseSkillCommand) {
        lines.push(`完了したら次に \`/${opts.nextPhaseSkillCommand}\` を実行してください`);
      }
      return lines.join('\n');
    },
  };
}
