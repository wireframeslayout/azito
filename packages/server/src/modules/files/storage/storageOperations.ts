import { CopyObjectCommand, DeleteObjectsCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';

export class StorageOperationError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export function validateStoragePath(path: string, folder: boolean, allowRoot = false): string {
  if (path === '' && allowRoot) return path;
  if (!path || /[\\\x00-\x1f\x7f]/.test(path) || path.startsWith('/') || path.endsWith('/') !== folder) throw new StorageOperationError(400, 'invalid_path', 'Invalid storage path');
  const parts = (folder ? path.slice(0, -1) : path).split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new StorageOperationError(400, 'invalid_path', 'Invalid storage path');
  return path;
}

function base(projectId: number): string { return `projects/${projectId}/`; }
function copySource(bucket: string, key: string): string { return `/${encodeURIComponent(bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`; }
export function isMissing(error: unknown): boolean {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === 'NotFound' || e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404;
}

export class StorageOperations {
  constructor(private s3: S3Client, private bucket: string, private projectId: number) {}
  private key(path: string): string { return base(this.projectId) + path; }
  private async head(key: string) {
    try { return await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key })); }
    catch (error) { if (isMissing(error)) return null; throw error; }
  }
  private async exists(prefix: string): Promise<boolean> {
    const page = await this.s3.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: this.key(prefix), MaxKeys: 1 }));
    return (page.Contents ?? []).length > 0;
  }
  private async scan(prefix: string, max?: number): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = await this.s3.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: this.key(prefix), ContinuationToken: token }));
      keys.push(...(page.Contents ?? []).flatMap((entry) => entry.Key ? [entry.Key] : []));
      if (max !== undefined && keys.length > max) throw new StorageOperationError(413, 'folder_too_large', 'Folder contains more than 1000 objects');
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
      if (page.IsTruncated && !token) throw new Error('Missing continuation token');
    } while (token);
    return keys;
  }
  async listPage(prefix: string, limit: number, cursor?: string) {
    validateStoragePath(prefix, true, true);
    let page;
    try { page = await this.s3.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: this.key(prefix), Delimiter: '/', MaxKeys: limit, ContinuationToken: cursor })); }
    catch (error) {
      if (cursor && (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 400) throw new StorageOperationError(400, 'invalid_cursor', 'Invalid cursor');
      throw error;
    }
    const folders = (page.CommonPrefixes ?? []).flatMap((p) => {
      if (!p.Prefix) return [];
      const relative = p.Prefix.slice(base(this.projectId).length);
      return [{ name: relative.slice(0, -1).split('/').pop()!, prefix: relative }];
    });
    const objects = (page.Contents ?? []).filter((o) => o.Key && o.Key !== this.key(prefix));
    const results: Array<{ key: string; displayName: string; size: number; lastModified: string; etag: string | null } | null> = new Array(objects.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(10, objects.length) }, async () => {
      while (next < objects.length) {
        const index = next++;
        const obj = objects[index];
        const key = obj.Key!;
        const head = await this.head(key);
        if (!head) { results[index] = null; continue; }
        const encodedName = head.Metadata?.['display-name'];
        results[index] = { key, displayName: encodedName ? decodeURIComponent(encodedName) : key.split('/').pop()!.replace(/^\d+_/, ''), size: obj.Size ?? 0, lastModified: obj.LastModified?.toISOString() ?? '', etag: obj.ETag ?? null };
      }
    }));
    const files = results.filter((file) => file !== null);
    return { prefix, folders, files, nextCursor: page.NextContinuationToken ?? null };
  }
  async createFolder(path: string): Promise<void> {
    validateStoragePath(path, true);
    if (await this.exists(path)) throw new StorageOperationError(409, 'exists', 'Folder already exists');
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: this.key(path), Body: Buffer.alloc(0) }));
  }
  async renameFile(path: string, name: string): Promise<void> {
    validateStoragePath(path, false); validateStoragePath(name, false);
    if (name.includes('/')) throw new StorageOperationError(400, 'invalid_path', 'Invalid name');
    const key = this.key(path); const head = await this.head(key);
    if (!head) throw new StorageOperationError(404, 'not_found', 'File not found');
    await this.s3.send(new CopyObjectCommand({ Bucket: this.bucket, Key: key, CopySource: copySource(this.bucket, key), MetadataDirective: 'REPLACE', Metadata: { ...head.Metadata, 'display-name': encodeURIComponent(name) }, ContentType: head.ContentType }));
  }
  async statPrefix(path: string): Promise<{ count: number; totalSize: number }> {
    validateStoragePath(path, true);
    let token: string | undefined; let count = 0; let totalSize = 0;
    do {
      const page = await this.s3.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: this.key(path), ContinuationToken: token }));
      for (const object of page.Contents ?? []) { count++; totalSize += object.Size ?? 0; }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
      if (page.IsTruncated && !token) throw new Error('Missing continuation token');
    } while (token);
    return { count, totalSize };
  }
  private async remove(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 1000) {
      const result = await this.s3.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })) } }));
      if (result.Errors?.length) throw new StorageOperationError(502, 'partial_failure', `Storage deletion partially failed (${result.Errors.length} objects)`);
    }
  }
  async deletePaths(paths: string[]): Promise<void> {
    const keys: string[] = [];
    for (const path of paths) {
      validateStoragePath(path, path.endsWith('/'));
      keys.push(...(path.endsWith('/') ? await this.scan(path) : [this.key(path)]));
    }
    await this.remove([...new Set(keys)]);
  }
  async renameFolder(path: string, name: string): Promise<void> {
    validateStoragePath(path, true); validateStoragePath(name, false);
    if (name.includes('/')) throw new StorageOperationError(400, 'invalid_path', 'Invalid name');
    const parent = path.slice(0, -1).split('/').slice(0, -1).join('/');
    await this.moveObjects([path], parent ? `${parent}/` : '', name);
  }
  async moveObjects(paths: string[], destination: string, rename?: string): Promise<void> {
    validateStoragePath(destination, true, true);
    const mapping = new Map<string, string>();
    const destinations = new Set<string>();
    for (const path of paths) {
      const folder = path.endsWith('/'); validateStoragePath(path, folder);
      if (folder && destination.startsWith(path)) throw new StorageOperationError(400, 'invalid_path', 'Cannot move a folder into itself');
      const leaf = (folder ? path.slice(0, -1) : path).split('/').pop()! + (folder ? '/' : '');
      const target = destination + (rename ? rename + (folder ? '/' : '') : leaf);
      if (folder && await this.exists(target)) throw new StorageOperationError(409, 'exists', 'Destination already exists');
      const keys = folder ? await this.scan(path, 1000) : [this.key(path)];
      if (!keys.length || (!folder && !(await this.head(keys[0])))) throw new StorageOperationError(404, 'not_found', 'Source not found');
      for (const key of keys) {
        const dest = this.key(target + key.slice(this.key(path).length));
        if (mapping.has(key) || destinations.has(dest)) throw new StorageOperationError(400, 'duplicate', 'Duplicate selection');
        mapping.set(key, dest); destinations.add(dest);
      }
      if (mapping.size > 1000) throw new StorageOperationError(413, 'folder_too_large', 'Move contains more than 1000 objects');
    }
    for (const dest of mapping.values()) if (await this.head(dest)) throw new StorageOperationError(409, 'exists', 'Destination already exists');
    const copied: string[] = [];
    try {
      for (const [source, dest] of mapping) {
        await this.s3.send(new CopyObjectCommand({ Bucket: this.bucket, Key: dest, CopySource: copySource(this.bucket, source) })); copied.push(dest);
      }
    } catch (error) {
      try { await this.remove(copied); } catch { throw new StorageOperationError(502, 'partial_failure', 'Copy failed and destination cleanup partially failed'); }
      throw error;
    }
    try { await this.remove([...mapping.keys()]); }
    catch { throw new StorageOperationError(502, 'partial_failure', 'Objects were copied but some sources could not be deleted'); }
  }
}
