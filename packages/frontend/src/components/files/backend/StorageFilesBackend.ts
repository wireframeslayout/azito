import { apiWithStatus, fetchBlob, uploadFile } from '../../../api/client';
import type { FileEntry, FileReadResult, FileSaveResult, FilesBackend } from './FilesBackend';

interface StorageResponse {
  error?: string;
  code?: string;
  content?: string;
  language?: string;
  version?: string;
  latest?: StorageResponse | null;
  file?: { key: string };
}
interface ListResponse extends StorageResponse {
  folders: Array<{ name: string; prefix: string }>;
  files: Array<{ key: string; displayName: string; size: number }>;
  nextCursor: string | null;
}

export class StorageFilesBackend implements FilesBackend {
  constructor(private readonly projectId: number) {}
  private get root(): string { return `/projects/${this.projectId}/storage`; }
  private relative(path: string): string {
    const root = `projects/${this.projectId}/`;
    if (!path.startsWith(root)) throw new Error('Invalid storage key');
    return path.slice(root.length);
  }
  async list(path: string): Promise<FileEntry[]> {
    const prefix = path.startsWith(`projects/${this.projectId}/`) ? this.relative(path) : path;
    const entries: FileEntry[] = [];
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ prefix });
      if (cursor) query.set('cursor', cursor);
      const { status, body } = await apiWithStatus<ListResponse>(`${this.root}/entries?${query}`);
      if (status >= 400) throw new Error(body.error || 'Failed to load directory');
      entries.push(...body.folders.map((f) => ({ name: f.name, type: 'directory' as const, path: f.prefix })));
      entries.push(...body.files.map((f) => ({ name: f.displayName, type: 'file' as const, path: f.key, size: f.size })));
      cursor = body.nextCursor;
    } while (cursor);
    return entries;
  }
  private toRead(body: StorageResponse): FileReadResult {
    if (body.error) return { kind: 'unavailable', reason: body.error };
    if (typeof body.content !== 'string' || typeof body.language !== 'string' || typeof body.version !== 'string') throw new Error('Invalid file response');
    return { kind: 'text', content: body.content, language: body.language, version: body.version };
  }
  async read(path: string): Promise<FileReadResult> {
    const { status, body } = await apiWithStatus<StorageResponse>(`${this.root}/content?key=${encodeURIComponent(path)}`);
    if (status === 400 || status === 403 || status === 413) return { kind: 'unavailable', reason: body.error || 'Cannot edit file' };
    if (status >= 400) throw new Error(body.error || 'Failed to load file');
    return this.toRead(body);
  }
  async save(path: string, content: string, version: string, force: boolean): Promise<FileSaveResult> {
    const { status, body } = await apiWithStatus<StorageResponse>(`${this.root}/content`, { method: 'PUT', body: JSON.stringify({ key: path, content, version, force }) });
    if (status === 409 && body.code === 'conflict') {
      return { kind: 'conflict', latest: body.latest ? this.toRead(body.latest) : null };
    }
    if (status >= 400 || body.error) throw new Error(body.error || 'Failed to save file');
    if (typeof body.version !== 'string') throw new Error('Invalid save response');
    return { kind: 'saved', version: body.version };
  }
  private async mutate(endpoint: string, method: string, body: object): Promise<void> {
    const result = await apiWithStatus<StorageResponse>(`${this.root}${endpoint}`, { method, body: JSON.stringify(body) });
    if (result.status >= 400 || result.body.error) throw new Error(result.body.error || 'Storage operation failed');
  }
  async create(path: string, type: 'file' | 'directory'): Promise<string> {
    if (type === 'directory') {
      const prefix = path.endsWith('/') ? path : `${path}/`;
      await this.mutate('/folders', 'POST', { prefix });
      return prefix;
    }
    const relative = path.startsWith(`projects/${this.projectId}/`) ? this.relative(path) : path;
    const slash = relative.lastIndexOf('/');
    const prefix = relative.slice(0, slash + 1);
    const name = relative.slice(slash + 1);
    const result = await uploadFile<StorageResponse>(`${this.root}/upload?prefix=${encodeURIComponent(prefix)}`, new File([''], name, { type: 'text/plain' }));
    if (result.error) throw new Error(result.error);
    if (!result.file?.key) throw new Error('Invalid upload response');
    return result.file.key;
  }
  rename(path: string, newName: string): Promise<void> {
    return this.mutate('/entries', 'PATCH', path.endsWith('/') ? { prefix: path, newName } : { key: path, displayName: newName });
  }
  delete(path: string, type: 'file' | 'directory'): Promise<void> {
    return this.mutate('/delete', 'POST', type === 'directory' ? { keys: [], prefixes: [path] } : { keys: [path], prefixes: [] });
  }
  move(path: string, type: 'file' | 'directory', destination: string): Promise<void> {
    return this.mutate('/move', 'POST', { keys: type === 'file' ? [path] : [], prefixes: type === 'directory' ? [path] : [], destPrefix: destination });
  }
  download(path: string): Promise<Blob> { return fetchBlob(`${this.root}/${encodeURIComponent(this.relative(path))}/raw?download=true`); }
}
