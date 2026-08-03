import type { ILlmClient } from './ILlmClient';

export type PaneStatus = 'phase_complete' | 'still_working' | 'question' | 'stopped';

export interface PaneQuestion {
  text: string;
  type: 'select' | 'text';
  options?: string[];
  selected?: number;
}

export interface PaneClassification {
  status: PaneStatus;
  questions?: PaneQuestion[];
}

const QUESTIONS_JSON_MARKER = 'QUESTIONS_JSON:';
const INTERACTIVE_PROMPT_RE = /Enter to select.*Tab.*to navigate.*Esc to cancel/i;
const INTERACTIVE_CONFIRM_RE = /Enter to confirm.*Esc to cancel/i;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class PaneClassifier {
  constructor(private llmClient: ILlmClient) {}

  async classify(
    paneContent: string,
    baselineMarkerCounts: { phaseComplete: number; question: number },
    doneMarker?: string,
  ): Promise<PaneClassification> {
    const stripped = paneContent.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');

    // If prompt template end tag is visible, agent hasn't started processing yet
    const tail = stripped.split('\n').slice(-15).join('\n');
    if (tail.includes('</output>')) {
      return { status: 'still_working' };
    }

    if (this.isStartupBannerOnly(stripped)) {
      return { status: 'still_working' };
    }

    const programmatic = this.programmaticClassify(stripped, baselineMarkerCounts, doneMarker);
    if (programmatic) {
      if (programmatic.status === 'question' && (!programmatic.questions || programmatic.questions.length === 0)) {
        const llmResult = await this.llmClassify(stripped, doneMarker);
        if (llmResult.questions && llmResult.questions.length > 0) {
          programmatic.questions = llmResult.questions;
        } else {
          programmatic.questions = this.extractQuestionsFromText(stripped);
        }
      }
      return programmatic;
    }

    const llmResult = await this.llmClassify(stripped, doneMarker);
    if (llmResult.status === 'question' && (!llmResult.questions || llmResult.questions.length === 0)) {
      llmResult.questions = this.extractQuestionsFromText(stripped);
    }
    return llmResult;
  }

  private isStartupBannerOnly(stripped: string): boolean {
    const hasStartupIndicator = /Claude Code|\/help|What would you like to do\?|Tips:/i.test(stripped);
    if (!hasStartupIndicator) return false;

    const hasUserTurnIndicator = /AZITO_DONE_|AZITO_QUESTIONS_|Thinking|Mulling|Hyperspacing|Deepening|⏺/i.test(stripped);
    if (hasUserTurnIndicator) return false;

    const nonBlankLines = stripped.split('\n').filter((line) => line.trim().length > 0).length;
    return nonBlankLines <= 30;
  }

  private programmaticClassify(
    stripped: string,
    baseline: { phaseComplete: number; question: number },
    doneMarker?: string,
  ): PaneClassification | null {
    const pcCount = (stripped.match(/PHASE_COMPLETE/gi) || []).length;
    if (pcCount > baseline.phaseComplete) {
      return { status: 'phase_complete' };
    }

    // Check if the done marker appears as agent output (not just in the instruction echo)
    if (doneMarker) {
      const markerRe = new RegExp(`^[⏺>\\s]*${escapeRegExp(doneMarker)}\\s*$`, 'm');
      if (markerRe.test(stripped)) {
        return { status: 'phase_complete' };
      }
    }

    // QUESTIONS_JSON structured output (highest priority for questions)
    const jsonQuestions = this.extractQuestionsJson(stripped);
    if (jsonQuestions && jsonQuestions.length > 0 && !jsonQuestions.some(q => q.text === 'question text' || q.text === 'open question')) {
      return { status: 'question', questions: jsonQuestions };
    }

    const qCount = (stripped.match(/QUESTION:/gi) || []).length;
    if (qCount > baseline.question) {
      return { status: 'question' };
    }

    const tail = stripped.split('\n').slice(-10).join('\n');
    if (INTERACTIVE_PROMPT_RE.test(tail) || INTERACTIVE_CONFIRM_RE.test(tail)) {
      return { status: 'question' };
    }

    return null;
  }

  private async llmClassify(stripped: string, doneMarker?: string): Promise<PaneClassification> {
    const tail = stripped.split('\n').slice(-80).join('\n');

    const markerHint = doneMarker
      ? `- The completion marker for this task is "${doneMarker}". If the agent's own output (not the instruction echo) contains it, classify as phase_complete.\n`
      : '';

    const prompt = `You are a terminal output classifier for a development agent manager.

Analyze the following terminal pane output and classify the agent's current state.

<pane_output>
${tail}
</pane_output>

Respond with ONLY a JSON object (no markdown, no explanation):
{
  "status": "phase_complete" | "still_working" | "question" | "stopped",
  "questions": [
    {
      "text": "question text",
      "type": "select" | "text",
      "options": ["option1", "option2"],
      "selected": 0
    }
  ]
}

Rules:
- "phase_complete": The agent has finished its task and is idle (shell prompt visible, or PHASE_COMPLETE marker)
${markerHint}- "still_working": The agent is actively processing (thinking indicator like "Thinking...", spinner, running commands, streaming output)
- "question": The agent is waiting for user input (interactive selection, text prompt, question)
- "stopped": The agent has crashed or exited with an error
- "questions" array is REQUIRED when status is "question". You MUST extract ALL visible questions.
- For Claude Code wizard UIs with multiple ☐/✔ tabs or steps, extract the question text for EVERY wizard step shown in the pane, not only the currently active step.
- For "select" type questions, extract all available options and which one is currently highlighted (❯ marker = selected, 0-based index)
- For "text" type questions, omit "options"
- Status bar lines such as "bypass permissions on (shift+tab to cycle)" are UI chrome and must NOT be used as evidence of the agent's working state.
- If the Claude Code input box is empty and no spinner ("esc to interrupt" etc.) is visible, the agent is idle; if the preceding output contains a completion report, classify as phase_complete.

Common interactive UI patterns:
- Claude Code selection UI: numbered options (1. option, 2. option...) with "Enter to select · Tab/Arrow keys to navigate · Esc to cancel"
- Claude Code wizard: multiple steps shown as ☐/✔ tabs at top, with options listed below
- The question text is usually above the options list
- Look for the ❯ marker to determine which option is currently selected`;

    try {
      const raw = await this.llmClient.exec(prompt);
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { status: 'still_working' };
      const parsed = JSON.parse(jsonMatch[0]) as PaneClassification;
      if (!['phase_complete', 'still_working', 'question', 'stopped'].includes(parsed.status)) {
        return { status: 'still_working' };
      }
      return parsed;
    } catch {
      return { status: 'still_working' };
    }
  }

  extractQuestionsJson(text: string): PaneQuestion[] | null {
    const stripped = text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
    const markerIdx = stripped.indexOf(QUESTIONS_JSON_MARKER);
    if (markerIdx < 0) return null;

    const afterMarker = stripped.slice(markerIdx + QUESTIONS_JSON_MARKER.length).trimStart();
    if (!afterMarker.startsWith('[')) return null;

    let depth = 0;
    let endIdx = -1;
    for (let i = 0; i < afterMarker.length; i++) {
      if (afterMarker[i] === '[') depth++;
      else if (afterMarker[i] === ']') { depth--; if (depth === 0) { endIdx = i; break; } }
    }
    if (endIdx < 0) return null;

    try {
      return JSON.parse(afterMarker.slice(0, endIdx + 1)) as PaneQuestion[];
    } catch {
      return null;
    }
  }

  private extractQuestionsFromText(stripped: string): PaneQuestion[] {
    const lines = stripped.split('\n');
    const questions: PaneQuestion[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const qMatch = line.match(/^QUESTION:\s*(.+)/i);
      if (qMatch) {
        questions.push({ text: qMatch[1].trim(), type: 'text' });
      }
    }

    if (questions.length === 0) {
      const tail = lines.slice(-40).join('\n');
      if (INTERACTIVE_PROMPT_RE.test(tail) || INTERACTIVE_CONFIRM_RE.test(tail)) {
        const questionLines: string[] = [];
        for (let i = lines.length - 1; i >= Math.max(0, lines.length - 40); i--) {
          const line = lines[i].trim();
          if (/^[?？]/.test(line) || line.endsWith('?') || line.endsWith('？')) {
            questionLines.unshift(line);
          }
        }
        if (questionLines.length > 0) {
          questions.push({ text: questionLines.join('\n'), type: 'text' });
        } else {
          questions.push({ text: 'Agent is asking a question (check terminal for details)', type: 'text' });
        }
      }
    }

    return questions;
  }
}
