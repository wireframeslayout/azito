export interface FileEntry {
  name: string;
  type: 'file' | 'directory';
  path: string;
  size?: number;
  lastModified?: string;
}

/** Why a file cannot be edited as text. */
export type TextUnavailableCode = 'too_large' | 'binary' | 'invalid_utf8' | 'not_text' | 'forbidden';

export interface TextUnavailable { kind: 'unavailable'; code: TextUnavailableCode; message: string }

const ANSWERED_CODES: ReadonlySet<string> = new Set(['too_large', 'binary', 'invalid_utf8', 'forbidden']);

/** Reads the reason a host answered with; `null` when the answer is not one of them (an error, not an uneditable file). */
export function unavailableFrom(code: string | undefined, message: string): TextUnavailable | null {
  return code !== undefined && ANSWERED_CODES.has(code) ? { kind: 'unavailable', code: code as TextUnavailableCode, message } : null;
}

export type FileReadResult =
  | { kind: 'text'; content: string; language: string; version: string }
  | TextUnavailable;

export type FileSaveResult =
  | { kind: 'saved'; version: string }
  | { kind: 'conflict'; latest: FileReadResult | null };

export interface FilesBackend {
  /** Identifies where documents live; a new backend instance with the same source reads the same files. */
  readonly source: string;
  list(path: string): Promise<FileEntry[]>;
  read(path: string): Promise<FileReadResult>;
  save(path: string, content: string, version: string, force: boolean): Promise<FileSaveResult>;
  create(path: string, type: 'file' | 'directory'): Promise<string>;
  rename(path: string, newName: string): Promise<void>;
  delete(path: string, type: 'file' | 'directory'): Promise<void>;
  download(path: string): Promise<Blob>;
  move?(path: string, type: 'file' | 'directory', destination: string): Promise<void>;
}
