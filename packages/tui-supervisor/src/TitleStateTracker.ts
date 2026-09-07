import {
  classifyTitle as sharedClassifyTitle,
  WORKING_SPINNER_TITLE_RE,
  CLAUDE_IDLE_TITLE_RE,
  type AgentKind,
} from '@azito/shared';

export type TitleAgentState = 'working' | 'idle' | 'blocked' | 'unknown';

const MAX_PENDING_LEN = 4_096;

const OSC_TITLE_RE = /\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
const OSC_PARTIAL_TAIL_RE = /\x1b(?:\](?:[02](?:;[^\x07\x1b]*\x1b?)?)?)?$/;

function hasRecognizedMarker(agentKind: AgentKind, title: string): boolean {
  if (title.includes('Action Required')) return true;
  if (WORKING_SPINNER_TITLE_RE.test(title)) return true;
  if (agentKind === 'claude' && CLAUDE_IDLE_TITLE_RE.test(title)) return true;
  return false;
}

function classifyTitle(agentKind: AgentKind, title: string): TitleAgentState {
  return sharedClassifyTitle(agentKind, title) as TitleAgentState;
}

export class TitleStateTracker {
  private readonly agentKind: AgentKind;
  private pending = '';
  private state: TitleAgentState = 'unknown';
  private markerSeen = false;

  constructor(agentKind: AgentKind = 'claude') {
    this.agentKind = agentKind;
  }

  push(chunk: string): void {
    let data = this.pending + chunk;
    this.pending = '';

    let lastTitle: string | null = null;
    let markerInChunk = false;
    OSC_TITLE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    let scannedUpTo = 0;
    while ((match = OSC_TITLE_RE.exec(data)) !== null) {
      lastTitle = match[1];
      if (hasRecognizedMarker(this.agentKind, lastTitle)) markerInChunk = true;
      scannedUpTo = OSC_TITLE_RE.lastIndex;
    }

    const tailRegion = data.slice(scannedUpTo);
    const partial = OSC_PARTIAL_TAIL_RE.exec(tailRegion);
    if (partial && partial[0].length > 0 && partial[0].length <= MAX_PENDING_LEN) {
      this.pending = partial[0];
    }

    if (lastTitle !== null) {
      if (!this.markerSeen) {
        if (!markerInChunk) return;
        this.markerSeen = true;
      }
      const classified = classifyTitle(this.agentKind, lastTitle);
      if (classified === 'unknown') {
        // After marker has been seen, a non-empty unrecognized title still means
        // idle — the agent demonstrably drives its title, so a marker-less one
        // is a real signal (codex convention, matches the hub-side classifier).
        if (lastTitle.length > 0) {
          this.state = 'idle';
        }
        return;
      }
      this.state = classified;
    }
  }

  getState(): TitleAgentState {
    return this.state;
  }
}
