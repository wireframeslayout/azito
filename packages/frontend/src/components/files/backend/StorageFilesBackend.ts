import { apiWithStatus, fetchBlob, uploadFile } from '../../../api/client';
import { unavailableFrom, type FileEntry, type FileReadResult, type FileSaveResult, type FilesBackend } from './FilesBackend';
import { decodeBase64, encodeBase64 } from './binaryCodec';

interface StorageResponse {
  error?: string;
  code?: string;
  content?: string;
  language?: string;
  etag?: string;
  contentType?: string;
  latest?: StorageResponse | null;
  file?: { key: string };
  url?: string;
}
interface ListResponse extends StorageResponse {
  folders: Array<{ name: string; prefix: string }>;
  files: Array<{ key: string; displayName: string; size: number; lastModified: string }>;
  nextCursor: string | null;
}

export class StorageApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string) { super(message); }
}

export interface StoragePage { entries: FileEntry[]; nextCursor: string | null }
export interface StorageStat { count: number; totalSize: number }

export class StorageFilesBackend implements FilesBackend {
  constructor(private readonly projectId: number) {}
  get source(): string { return `storage:${this.projectId}`; }
  private get root(): string { return `/projects/${this.projectId}/storage`; }
  private relative(path: string): string {
    const root = `projects/${this.projectId}/`;
    if (!path.startsWith(root)) throw new Error('Invalid storage key');
    return path.slice(root.length);
  }
  private key(path: string): string { return `projects/${this.projectId}/${path}`; }
  async list(path: string): Promise<FileEntry[]> {
    const entries: FileEntry[] = [];
    let cursor: string | null = null;
    do {
      const page = await this.listPage(path, cursor);
      entries.push(...page.entries);
      cursor = page.nextCursor;
    } while (cursor);
    return entries;
  }
  async listPage(path: string, cursor: string | null): Promise<StoragePage> {
    const prefix = path.startsWith(`projects/${this.projectId}/`) ? this.relative(path) : path;
    const query = new URLSearchParams({ prefix });
    if (cursor !== null) query.set('cursor', cursor);
    const { status, body } = await apiWithStatus<ListResponse>(`${this.root}/entries?${query}`);
    if (status >= 400 || body.error) throw new Error(body.error || 'Failed to load directory');
    return { entries: [
      ...body.folders.map((f) => ({ name: f.name, type: 'directory' as const, path: f.prefix })),
      ...body.files.map((f) => ({ name: f.displayName, type: 'file' as const, path: this.relative(f.key), size: f.size, ...(f.lastModified ? { lastModified: f.lastModified } : {}) })),
    ], nextCursor: body.nextCursor };
  }
  async stat(prefix: string): Promise<StorageStat> {
    const { status, body } = await apiWithStatus<StorageStat & StorageResponse>(`${this.root}/stat?${new URLSearchParams({ prefix })}`);
    if (status >= 400 || body.error) throw new Error(body.error || 'Failed to inspect folder');
    return { count: body.count, totalSize: body.totalSize };
  }
  private selection(entries: FileEntry[]): { keys: string[]; prefixes: string[] } {
    return { keys: entries.filter((entry) => entry.type === 'file').map((entry) => this.key(entry.path)), prefixes: entries.filter((entry) => entry.type === 'directory').map((entry) => entry.path) };
  }
  deleteMany(entries: FileEntry[]): Promise<void> { return this.mutate('/delete', 'POST', this.selection(entries)); }
  moveMany(entries: FileEntry[], destination: string): Promise<void> { return this.mutate('/move', 'POST', { ...this.selection(entries), destPrefix: destination }); }
  private toRead(body: StorageResponse): FileReadResult {
    if (typeof body.content !== 'string' || typeof body.language !== 'string' || typeof body.etag !== 'string') throw new Error('Invalid file response');
    return { kind: 'text', content: body.content, language: body.language, version: body.etag };
  }
  async read(path: string): Promise<FileReadResult> {
    const { status, body } = await apiWithStatus<StorageResponse>(`${this.root}/content?key=${encodeURIComponent(this.key(path))}`);
    if (status >= 400) {
      const unavailable = unavailableFrom(status === 403 ? 'forbidden' : body.code, body.error || 'Cannot edit file');
      if (unavailable) return unavailable;
      throw new Error(body.error || 'Failed to load file');
    }
    return this.toRead(body);
  }
  async save(path: string, content: string, version: string, force: boolean): Promise<FileSaveResult> {
    const { status, body } = await apiWithStatus<StorageResponse>(`${this.root}/content`, { method: 'PUT', body: JSON.stringify({ key: this.key(path), content, baseEtag: force ? undefined : version, force }) });
    if (status === 409 && body.error === 'conflict') {
      if (typeof body.content === 'string' && typeof body.etag === 'string') return { kind: 'conflict', latest: { kind: 'text', content: body.content, version: body.etag, language: 'text' } };
      const latest = body.latest ?? null;
      // A latest version the host could not offer as text carries its reason; an unexplained one is reported as unreadable.
      if (latest?.error !== undefined) return { kind: 'conflict', latest: unavailableFrom(latest.code, latest.error) };
      return { kind: 'conflict', latest: latest ? this.toRead(latest) : null };
    }
    if (status >= 400 || body.error) throw new Error(body.error || 'Failed to save file');
    if (typeof body.etag !== 'string') throw new Error('Invalid save response');
    return { kind: 'saved', version: body.etag };
  }
  private async mutate(endpoint: string, method: string, body: object): Promise<void> {
    const result = await apiWithStatus<StorageResponse>(`${this.root}${endpoint}`, { method, body: JSON.stringify(body) });
    if (result.status >= 400 || result.body.error) throw new StorageApiError(result.body.error || 'Storage operation failed', result.status, result.body.code);
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
    return this.relative(result.file.key);
  }
  async ensureFolder(path: string): Promise<void> {
    const prefix = path.endsWith('/') ? path : `${path}/`;
    const result = await apiWithStatus<StorageResponse>(`${this.root}/folders`, { method: 'POST', body: JSON.stringify({ prefix }) });
    if (result.status < 400 && !result.body.error) return;
    if (result.status === 409 && result.body.code === 'exists') return;
    throw new StorageApiError(result.body.error || 'Storage operation failed', result.status, result.body.code);
  }
  rename(path: string, newName: string): Promise<void> {
    return this.mutate('/entries', 'PATCH', path.endsWith('/') ? { prefix: path, newName } : { key: this.key(path), displayName: newName });
  }
  delete(path: string, type: 'file' | 'directory'): Promise<void> {
    return this.mutate('/delete', 'POST', type === 'directory' ? { keys: [], prefixes: [path] } : { keys: [this.key(path)], prefixes: [] });
  }
  move(path: string, type: 'file' | 'directory', destination: string): Promise<void> {
    return this.mutate('/move', 'POST', { keys: type === 'file' ? [this.key(path)] : [], prefixes: type === 'directory' ? [path] : [], destPrefix: destination });
  }
  download(path: string): Promise<Blob> { return fetchBlob(`${this.root}/${encodeURIComponent(path)}/raw?download=true`); }
  async readBinary(path: string) {
    const { status, body } = await apiWithStatus<StorageResponse>(`${this.root}/object?${new URLSearchParams({ key: this.key(path) })}`);
    if (status >= 400 || typeof body.content !== 'string' || typeof body.etag !== 'string') throw new Error(body.error || 'Invalid file response');
    return { bytes: decodeBase64(body.content), version: body.etag };
  }
  async saveBinary(path: string, bytes: Uint8Array, version: string, force: boolean) {
    const { status, body } = await apiWithStatus<StorageResponse>(`${this.root}/object`, { method: 'PUT', body: JSON.stringify({ key: this.key(path), content: encodeBase64(bytes), baseEtag: force ? undefined : version, force }) });
    if (status === 409) return { kind: 'conflict' as const };
    if (status >= 400 || typeof body.etag !== 'string') throw new Error(body.error || 'Invalid save response');
    return { kind: 'saved' as const, version: body.etag };
  }
  async mediaUrl(path: string): Promise<string> {
    const { status, body } = await apiWithStatus<StorageResponse>(`${this.root}/media-url?${new URLSearchParams({ key: this.key(path) })}`);
    if (status >= 400 || typeof body.url !== 'string') throw new Error(body.error || 'Invalid media response');
    return body.url;
  }
}
