export type AgentKind = 'claude' | 'codex';
export type PaneAgentState = 'working' | 'idle' | 'blocked' | 'unknown';

export interface ScreenInput {
  above: string[];
  promptBox: string[];
}

export interface ScreenRule {
  id: string;
  state: PaneAgentState | 'skip';
  priority: number;
  region: 'above' | 'promptBox' | 'all';
  test: (lines: string[]) => boolean;
}

const CLAUDE_BODY_SPINNER = '[*·✢✳✶✻✽]';
const CLAUDE_SPINNER_LINE_RE = new RegExp(
  `^\\s*${CLAUDE_BODY_SPINNER}\\s+\\S+.*…(?:\\s+\\(\\d+[smh](?:\\s|·)|\\s*$)`,
);
const CLAUDE_INTERRUPT_LINE_RE = /^\s*[⏸⏵].*esc to interrupt(?:\s|·|$)/i;
const CLAUDE_PROMPT_LINE_RE = /^\s*❯/;

const lower = (lines: string[]) => lines.map((l) => l.toLowerCase());
const anyLine = (lines: string[], re: RegExp) => lines.some((l) => re.test(l));
const text = (lines: string[]) => lower(lines).join('\n');

export const CLAUDE_SCREEN_RULES: ScreenRule[] = [
  {
    id: 'transcript_viewer',
    state: 'skip',
    priority: 100,
    region: 'all',
    test: (ls) => text(ls.slice(-3)).includes('showing detailed transcript'),
  },
  {
    id: 'blocked_form',
    state: 'blocked',
    priority: 90,
    region: 'all',
    test: (ls) => {
      const t = text(ls);
      return (
        t.includes('esc to cancel') &&
        (t.includes('enter to confirm') || t.includes('enter to select'))
      );
    },
  },
  {
    id: 'permission_prompt',
    state: 'blocked',
    priority: 85,
    region: 'all',
    test: (ls) => {
      const t = text(ls);
      return (
        t.includes('do you want to proceed?') ||
        t.includes('requires approval') ||
        (/(❯|1\.)\s*yes/.test(t) && /2\.\s*no/.test(t))
      );
    },
  },
  {
    id: 'interrupt_line',
    state: 'working',
    priority: 70,
    region: 'above',
    test: (ls) => anyLine(ls, CLAUDE_INTERRUPT_LINE_RE),
  },
  {
    id: 'spinner_line',
    state: 'working',
    priority: 70,
    region: 'above',
    test: (ls) => anyLine(ls, CLAUDE_SPINNER_LINE_RE),
  },
  {
    id: 'background_work',
    state: 'working',
    priority: 65,
    region: 'above',
    test: (ls) => {
      const t = text(ls);
      return (
        /waiting for \d+ background agents/.test(t) ||
        /\d+ mcp tasks? still running/.test(t) ||
        /\(\S*\d+\S*\s*tokens\s*\)/i.test(t)
      );
    },
  },
  {
    id: 'prompt_box_idle',
    state: 'idle',
    priority: 50,
    region: 'promptBox',
    test: (ls) =>
      anyLine(ls, CLAUDE_PROMPT_LINE_RE) &&
      !text(ls).includes('enter to select') &&
      !text(ls).includes('esc to cancel'),
  },
];

export const CODEX_SCREEN_RULES: ScreenRule[] = [
  {
    id: 'confirm',
    state: 'blocked',
    priority: 90,
    region: 'all',
    test: (ls) => {
      const t = text(ls);
      return (
        t.includes('press enter to confirm or esc to cancel') ||
        t.includes('allow command?') ||
        t.includes('enter to submit')
      );
    },
  },
  {
    id: 'yes_no',
    state: 'blocked',
    priority: 85,
    region: 'all',
    test: (ls) => {
      const t = text(ls);
      return t.includes('[y/n]') || (t.includes('do you want to') && t.includes('yes'));
    },
  },
  {
    id: 'working',
    state: 'working',
    priority: 70,
    region: 'above',
    test: (ls) => /esc to interrupt/.test(text(ls)),
  },
];

export function classifyScreen(agent: AgentKind, input: ScreenInput): PaneAgentState | null {
  const rules = agent === 'claude' ? CLAUDE_SCREEN_RULES : CODEX_SCREEN_RULES;
  const all = [...input.above, ...input.promptBox];
  let best: ScreenRule | undefined;
  for (const r of rules) {
    const lines =
      r.region === 'above' ? input.above : r.region === 'promptBox' ? input.promptBox : all;
    if (lines.length === 0) continue;
    if (r.test(lines) && (!best || r.priority > best.priority)) best = r;
  }
  if (!best) return 'unknown';
  return best.state === 'skip' ? null : best.state;
}

export const WORKING_SPINNER_TITLE_RE = /^[⠀-⣿◐◑◒◓✻✶✽✢∗] /;
export const CLAUDE_IDLE_TITLE_RE = /^✳ /;

export function classifyTitle(agent: AgentKind, title: string): PaneAgentState {
  if (title.includes('Action Required')) return 'blocked';
  if (WORKING_SPINNER_TITLE_RE.test(title)) return 'working';
  if (agent === 'claude' && CLAUDE_IDLE_TITLE_RE.test(title)) return 'idle';
  if (agent === 'codex' && title.length > 0) return 'idle';
  return 'unknown';
}

export function splitPromptBox(rows: string[], maxAbove = 12): ScreenInput {
  const isRule = (l: string) => /^\s*─{10,}\s*$/.test(l);
  let bottom = -1;
  let top = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (!isRule(rows[i])) continue;
    if (bottom < 0) {
      bottom = i;
      continue;
    }
    top = i;
    break;
  }
  if (top < 0) {
    return { above: rows.filter((l) => l.trim() !== '').slice(-maxAbove), promptBox: [] };
  }
  return {
    above: rows
      .slice(0, top)
      .filter((l) => l.trim() !== '')
      .slice(-maxAbove),
    promptBox: rows.slice(top + 1, bottom),
  };
}
