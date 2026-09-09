import {
  classifyScreen,
  classifyTitle,
  splitPromptBox,
  type PaneAgentState as SharedPaneAgentState,
} from '@azito/shared';

export type PaneAgentState = 'working' | 'idle' | 'blocked' | 'unknown';

const _typeCheckForward: PaneAgentState = '' as SharedPaneAgentState;
const _typeCheckReverse: SharedPaneAgentState = '' as PaneAgentState;
void _typeCheckForward; void _typeCheckReverse;

export const CLASSIFIABLE_AGENT_TYPES = ['claude', 'codex'] as const;

export interface ClassifyPaneStateInput {
  paneTitle: string | null;
  screenTail?: string | null;
  agentType: 'claude' | 'codex' | 'generic' | string;
}

const CLAUDE_PROMPT_BOX_RE = /^\s*❯/m;

function classifyClaude(paneTitle: string, screenTail: string | null): PaneAgentState {
  if (screenTail) {
    const input = splitPromptBox(screenTail.split('\n'));
    const screen = classifyScreen('claude', input);
    if (screen !== null && screen !== 'unknown') return screen;
    // Fallback: the server-side capture-pane tail may not contain ─ rule lines,
    // so splitPromptBox cannot separate promptBox from above. Check the raw
    // screenTail for patterns that the structured rules would miss.
    const lower = screenTail.toLowerCase();
    if (lower.includes('esc to interrupt')) return 'working';
    if (CLAUDE_PROMPT_BOX_RE.test(screenTail)) return 'idle';
  }
  return classifyTitle('claude', paneTitle);
}

function classifyCodex(paneTitle: string, screenTail: string | null): PaneAgentState {
  if (screenTail) {
    const screen = classifyScreen('codex', splitPromptBox(screenTail.split('\n')));
    if (screen !== null && screen !== 'unknown') return screen;
  }
  return classifyTitle('codex', paneTitle);
}

export function classifyPaneState(input: ClassifyPaneStateInput): PaneAgentState {
  const paneTitle = input.paneTitle ?? '';
  const screenTail = input.screenTail ?? null;

  switch (input.agentType) {
    case 'claude':
      return classifyClaude(paneTitle, screenTail);
    case 'codex':
      return classifyCodex(paneTitle, screenTail);
    default:
      return 'unknown';
  }
}
