import { apiWithStatus, fetchBlob } from '../../../api/client';
import { unavailableFrom, type FileEntry, type FileReadResult, type FileSaveResult, type FilesBackend } from './FilesBackend';
import { decodeBase64, encodeBase64 } from './binaryCodec';

interface ResponseBody { error?: string; code?: string; content?: string; language?: string; mtime?: number; hash?: string; type?: string; url?: string }

export class ServerFilesBackend implements FilesBackend {
  constructor(private readonly serverName: string, private readonly projectId?: number) {}

  get source(): string { return `server:${this.serverName}`; }

  private get root(): string { return `/servers/${encodeURIComponent(this.serverName)}/files`; }

  async list(path: string): Promise<FileEntry[]> {
    const { status, body } = await apiWithStatus<FileEntry[] | ResponseBody>(`${this.root}?path=${encodeURIComponent(path)}`);
    if (status >= 400 || !Array.isArray(body)) throw new Error(('error' in body && body.error) || 'Failed to load directory');
    return body;
  }

  async read(path: string): Promise<FileReadResult> {
    const { status, body } = await apiWithStatus<ResponseBody>(`${this.root}/content?path=${encodeURIComponent(path)}`);
    if (status >= 400) {
      const unavailable = unavailableFrom(status === 403 ? 'forbidden' : body.code, body.error || 'Cannot edit file');
      if (unavailable) return unavailable;
      throw new Error(body.error || 'Failed to load file');
    }
    if (body.type) return { kind: 'unavailable', code: 'not_text', message: 'File is not text' };
    if (typeof body.content !== 'string' || typeof body.language !== 'string' || typeof body.mtime !== 'number' || typeof body.hash !== 'string') throw new Error('Invalid file response');
    return { kind: 'text', content: body.content, language: body.language, version: JSON.stringify({ mtime: body.mtime, hash: body.hash }) };
  }

  async save(path: string, content: string, version: string, force: boolean): Promise<FileSaveResult> {
    if (this.projectId == null) throw new Error('projectId is required');
    const base = JSON.parse(version) as { mtime: number; hash: string };
    const { status, body } = await apiWithStatus<ResponseBody>(`${this.root}/content`, { method: 'PUT', body: JSON.stringify({ path, content, projectId: this.projectId, force, ...(force ? {} : { baseMtime: base.mtime, baseHash: base.hash }) }) });
    if (status === 409 || body.error === 'conflict') {
      try { return { kind: 'conflict', latest: await this.read(path) }; } catch { return { kind: 'conflict', latest: null }; }
    }
    if (status >= 400 || body.error) throw new Error(body.error || 'Failed to save file');
    if (typeof body.mtime !== 'number' || typeof body.hash !== 'string') throw new Error('Invalid save response');
    return { kind: 'saved', version: JSON.stringify({ mtime: body.mtime, hash: body.hash }) };
  }

  private async mutate(method: string, body: object): Promise<void> {
    if (this.projectId == null) throw new Error('projectId is required');
    const result = await apiWithStatus<ResponseBody>(this.root, { method, body: JSON.stringify({ ...body, projectId: this.projectId }) });
    if (result.status >= 400 || result.body.error) throw new Error(result.body.error || 'File operation failed');
  }
  async create(path: string, type: 'file' | 'directory'): Promise<string> { await this.mutate('POST', { path, type }); return path; }
  rename(path: string, newName: string): Promise<void> { return this.mutate('PATCH', { path, newName }); }
  delete(path: string): Promise<void> { return this.mutate('DELETE', { path }); }
  download(path: string): Promise<Blob> { return fetchBlob(`${this.root}/download?path=${encodeURIComponent(path)}`); }
  async readBinary(path: string) {
    if (this.projectId == null) throw new Error('projectId is required');
    const { status, body } = await apiWithStatus<ResponseBody>(`${this.root}/binary?${new URLSearchParams({ path, projectId: String(this.projectId) })}`);
    if (status >= 400 || typeof body.content !== 'string' || typeof body.mtime !== 'number' || typeof body.hash !== 'string') throw new Error(body.code === 'too_large' ? 'preview_too_large' : (body.error || 'Invalid file response'));
    return { bytes: decodeBase64(body.content), version: JSON.stringify({ mtime: body.mtime, hash: body.hash }) };
  }
  async saveBinary(path: string, bytes: Uint8Array, version: string, force: boolean) {
    if (this.projectId == null) throw new Error('projectId is required');
    const base = JSON.parse(version) as { mtime: number; hash: string };
    const { status, body } = await apiWithStatus<ResponseBody>(`${this.root}/binary`, { method: 'PUT', body: JSON.stringify({ path, projectId: this.projectId, content: encodeBase64(bytes), force, ...(force ? {} : { baseMtime: base.mtime, baseHash: base.hash }) }) });
    if (status === 409) return { kind: 'conflict' as const };
    if (status >= 400 || typeof body.mtime !== 'number' || typeof body.hash !== 'string') throw new Error(body.error || 'Invalid save response');
    return { kind: 'saved' as const, version: JSON.stringify({ mtime: body.mtime, hash: body.hash }) };
  }
  async mediaUrl(path: string): Promise<string> {
    if (this.projectId == null) throw new Error('projectId is required');
    const { status, body } = await apiWithStatus<ResponseBody>(`${this.root}/media-url?${new URLSearchParams({ path, projectId: String(this.projectId) })}`);
    if (status >= 400 || typeof body.url !== 'string') throw new Error(body.error || 'Invalid media response');
    return body.url;
  }
}
