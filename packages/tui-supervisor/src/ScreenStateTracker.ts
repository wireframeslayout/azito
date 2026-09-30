import { Terminal } from '@xterm/headless';
import { classifyScreen, splitPromptBox, type AgentKind, type PaneAgentState } from '@azito/shared';

const DEBOUNCE_MS = 120;
const MAX_DEBOUNCE_MS = 300;
const SCAN_ROWS = 40;

export class ScreenStateTracker {
  private readonly term: Terminal;
  private readonly agent: AgentKind;
  private state: PaneAgentState = 'unknown';
  private timer: NodeJS.Timeout | undefined;
  private firstPendingAt = 0;
  private listeners: Array<(s: PaneAgentState) => void> = [];

  constructor(agent: AgentKind, cols = 80, rows = 24) {
    this.agent = agent;
    this.term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 });
  }

  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows);
  }

  push(chunk: string): void {
    const now = Date.now();
    if (!this.timer) this.firstPendingAt = now;
    if (this.timer) clearTimeout(this.timer);
    this.term.write(chunk, () => {
      if (this.timer) clearTimeout(this.timer);
      const wait = Math.max(0, Math.min(DEBOUNCE_MS, MAX_DEBOUNCE_MS - (Date.now() - this.firstPendingAt)));
      this.timer = setTimeout(() => this.evaluate(), wait);
      this.timer.unref();
    });
  }

  onChange(fn: (s: PaneAgentState) => void): void {
    this.listeners.push(fn);
  }

  getState(): PaneAgentState {
    return this.state;
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.term.dispose();
  }

  private evaluate(): void {
    this.timer = undefined;
    const buf = this.term.buffer.active;
    const rows: string[] = [];
    const start = Math.max(0, buf.length - SCAN_ROWS);
    for (let i = start; i < buf.length; i++) {
      rows.push(buf.getLine(i)?.translateToString(true) ?? '');
    }
    const next = classifyScreen(this.agent, splitPromptBox(rows));
    if (next === null || next === this.state) return;
    this.state = next;
    for (const fn of this.listeners) fn(next);
  }
}
