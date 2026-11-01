export interface FileEntry {
  name: string;
  type: 'file' | 'directory';
  path: string;
  size?: number;
}

export type FileReadResult =
  | { kind: 'text'; content: string; language: string; version: string }
  | { kind: 'unavailable'; reason: string };

export type FileSaveResult =
  | { kind: 'saved'; version: string }
  | { kind: 'conflict'; latest: FileReadResult | null };

export interface FilesBackend {
  list(path: string): Promise<FileEntry[]>;
  read(path: string): Promise<FileReadResult>;
  save(path: string, content: string, version: string, force: boolean): Promise<FileSaveResult>;
  create(path: string, type: 'file' | 'directory'): Promise<string>;
  rename(path: string, newName: string): Promise<void>;
  delete(path: string, type: 'file' | 'directory'): Promise<void>;
  download(path: string): Promise<Blob>;
  move?(path: string, type: 'file' | 'directory', destination: string): Promise<void>;
}
