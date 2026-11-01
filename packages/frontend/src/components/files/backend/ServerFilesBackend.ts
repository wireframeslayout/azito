import { apiWithStatus, fetchBlob } from '../../../api/client';
import type { FileEntry, FileReadResult, FileSaveResult, FilesBackend } from './FilesBackend';

interface ResponseBody { error?: string; content?: string; language?: string; mtime?: number; hash?: string; type?: string }

export class ServerFilesBackend implements FilesBackend {
  constructor(private readonly serverName: string, private readonly projectId?: number) {}

  private get root(): string { return `/servers/${encodeURIComponent(this.serverName)}/files`; }

  async list(path: string): Promise<FileEntry[]> {
    const { status, body } = await apiWithStatus<FileEntry[] | ResponseBody>(`${this.root}?path=${encodeURIComponent(path)}`);
    if (status >= 400 || !Array.isArray(body)) throw new Error(('error' in body && body.error) || 'Failed to load directory');
    return body;
  }

  async read(path: string): Promise<FileReadResult> {
    const { status, body } = await apiWithStatus<ResponseBody>(`${this.root}/content?path=${encodeURIComponent(path)}`);
    if (status >= 400) {
      if (status === 400 || status === 413 || status === 403) return { kind: 'unavailable', reason: body.error || 'Cannot edit file' };
      throw new Error(body.error || 'Failed to load file');
    }
    if (body.type) return { kind: 'unavailable', reason: 'File is not text' };
    if (typeof body.content !== 'string' || typeof body.language !== 'string' || typeof body.mtime !== 'number' || typeof body.hash !== 'string') throw new Error('Invalid file response');
    return { kind: 'text', content: body.content, language: body.language, version: JSON.stringify({ mtime: body.mtime, hash: body.hash }) };
  }

  async save(path: string, content: string, version: string, force: boolean): Promise<FileSaveResult> {
    if (this.projectId == null) throw new Error('projectId is required');
    const base = JSON.parse(version) as { mtime: number; hash: string };
    const { status, body } = await apiWithStatus<ResponseBody>(`${this.root}/content`, { method: 'PUT', body: JSON.stringify({ path, content, projectId: this.projectId, force, baseMtime: base.mtime, baseHash: base.hash }) });
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
}
