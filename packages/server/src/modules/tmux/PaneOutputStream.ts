import { EventEmitter } from 'events';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { IPaneStream } from './PaneStream';

export type { IPaneStream };

// ─── Shared marker detection logic ───

const MAX_BUFFER_SIZE = 2 * 1024 * 1024;

export abstract class BasePaneStream extends EventEmitter implements IPaneStream {
  protected buffer = '';
  protected closed = false;
  protected markerEnabled = false;
  protected initialLineCount = 0;
  protected lineCount = 0;
  protected doneMarker: string | null = null;
  protected questionsMarker: string | null = null;
  protected questionsAccum: string | null = null;
  protected questionsDepth = 0;
  protected partial = '';
  protected abstract filePath: string;

  setMarkers(done: string, questions: string): void {
    this.doneMarker = done;
    this.questionsMarker = questions;
  }

  getFilePath(): string {
    return this.filePath;
  }

  enableMarkerDetection(): void {
    this.initialLineCount = this.lineCount;
    this.markerEnabled = true;
  }

  abstract start(): void;
  abstract stop(): void;

  getBuffer(): string {
    return this.buffer;
  }

  protected processChunk(text: string): void {
    const parts = (this.partial + text).split('\n');
    this.partial = parts.pop()!;

    for (const rawLine of parts) {
      this.lineCount++;
      const stripped = rawLine.replace(/\r+$/, '');
      const crIdx = stripped.lastIndexOf('\r');
      const cleanLine = crIdx >= 0 ? stripped.slice(crIdx + 1) : stripped;

      this.buffer += cleanLine + '\n';
      this.emit('data', cleanLine + '\n');
      this.checkRawSegments(stripped);
    }

    if (this.buffer.length > MAX_BUFFER_SIZE) {
      const prefix = '[...truncated]\n';
      this.buffer = prefix + this.buffer.slice(this.buffer.length - (MAX_BUFFER_SIZE - prefix.length));
    }
  }

  private checkRawSegments(stripped: string): void {
    const segments = stripped.split('\r');
    for (const seg of segments) {
      this.checkLine(seg);
    }
  }

  private checkLine(line: string): void {
    if (!this.markerEnabled) return;
    if (this.lineCount <= this.initialLineCount) return;

    const trimmed = line.trimStart();
    const donePattern = this.doneMarker || 'PHASE_COMPLETE';
    const questionsPattern = this.questionsMarker ? `${this.questionsMarker}:` : 'QUESTIONS_JSON:';

    if (this.questionsAccum !== null) {
      this.questionsAccum += line;
      this.questionsDepth += this.countBrackets(line);
      if (this.questionsDepth <= 0) {
        this.tryEmitQuestions(this.questionsAccum);
        this.questionsAccum = null;
        this.questionsDepth = 0;
      }
      return;
    }

    if (trimmed.startsWith(questionsPattern)) {
      const afterMarker = trimmed.slice(questionsPattern.length).trimStart();
      if (afterMarker.startsWith('[')) {
        const depth = this.countBrackets(afterMarker);
        if (depth <= 0) {
          const json = this.extractJsonArray(afterMarker);
          if (json) this.tryEmitQuestions(json);
        } else {
          this.questionsAccum = afterMarker;
          this.questionsDepth = depth;
        }
        return;
      }
      if (afterMarker === '') {
        this.questionsAccum = '';
        this.questionsDepth = 0;
        return;
      }
    }

    if (this.questionsAccum === '' && trimmed.startsWith('[')) {
      const depth = this.countBrackets(trimmed);
      if (depth <= 0) {
        this.tryEmitQuestions(trimmed);
        this.questionsAccum = null;
      } else {
        this.questionsAccum = trimmed;
        this.questionsDepth = depth;
      }
      return;
    }
    if (this.questionsAccum === '') {
      this.questionsAccum = null;
      this.questionsDepth = 0;
    }

    if (trimmed.startsWith(donePattern)) {
      this.emit('marker', 'phase_complete', this.buffer);
    }
  }

  private countBrackets(text: string): number {
    let depth = 0;
    for (const ch of text) {
      if (ch === '[') depth++;
      else if (ch === ']') depth--;
    }
    return depth;
  }

  private tryEmitQuestions(text: string): void {
    const json = this.extractJsonArray(text);
    if (!json) return;
    try {
      const parsed = JSON.parse(json);
      if (Array.isArray(parsed) && !parsed.some((q: { text: string }) => q.text === 'question text' || q.text === 'open question')) {
        this.emit('marker', 'questions_json', json);
      }
    } catch { /* invalid JSON, ignore */ }
  }

  private extractJsonArray(text: string): string | null {
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '[') depth++;
      else if (text[i] === ']') { depth--; if (depth === 0) return text.slice(0, i + 1); }
    }
    return null;
  }
}

// ─── Local: tail -f on local file ───

export class PaneOutputStream extends BasePaneStream {
  protected filePath: string;
  private tailProc: ChildProcess | null = null;

  constructor(paneId: string) {
    super();
    this.filePath = path.join(os.tmpdir(), `azito-pipe-${paneId}-${Date.now()}.log`);
  }

  start(): void {
    fs.writeFileSync(this.filePath, '');
    this.tailProc = spawn('tail', ['-f', '-n', '+1', this.filePath], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    this.tailProc.stdout!.on('data', (chunk: Buffer) => {
      if (this.closed) return;
      this.processChunk(chunk.toString('utf-8'));
    });
    this.tailProc.on('error', (err) => this.emit('error', err));
  }

  stop(): void {
    this.closed = true;
    if (this.tailProc) { this.tailProc.kill('SIGTERM'); this.tailProc = null; }
    try { fs.unlinkSync(this.filePath); } catch {}
  }
}

