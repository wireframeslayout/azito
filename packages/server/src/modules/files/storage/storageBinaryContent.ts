import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { StorageOperationError, isMissing, validateStoragePath } from './storageOperations';

const MAX_BYTES = 20 * 1024 * 1024;
const normalizeEtag = (etag: string): string => etag.replace(/^"|"$/g, '');
const status = (error: unknown): number | undefined => (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;

export class StorageBinaryContent {
  constructor(private readonly s3: S3Client, private readonly bucket: string, private readonly projectId: number, private readonly maxFileSize: number) {}

  private key(path: string): string { return `projects/${this.projectId}/${validateStoragePath(path, false)}`; }

  async statMedia(path: string): Promise<{ size: number; etag: string; contentType: string }> {
    const result = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(path) }));
    if (result.ContentLength === undefined || !result.ETag) throw new Error('Storage object metadata is incomplete');
    return { size: result.ContentLength, etag: result.ETag, contentType: result.ContentType || 'application/octet-stream' };
  }

  async streamMedia(path: string, etag: string, range?: string) {
    const result = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key(path), IfMatch: etag, ...(range ? { Range: range } : {}) }));
    if (!result.Body) throw new Error('Storage object body is missing');
    return result.Body;
  }

  async read(path: string): Promise<{ data: Buffer; etag: string }> {
    const key = this.key(path);
    let object;
    try { object = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key })); }
    catch (error) { if (isMissing(error)) throw new StorageOperationError(404, 'not_found', 'File not found'); throw error; }
    if (object.ContentLength === undefined || !object.ETag || !object.Body) throw new Error('Storage object metadata is incomplete');
    if (object.ContentLength > MAX_BYTES) throw new StorageOperationError(413, 'too_large', 'File exceeds 20 MiB');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of object.Body as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > MAX_BYTES) throw new StorageOperationError(413, 'too_large', 'File exceeds 20 MiB');
      chunks.push(Buffer.from(chunk));
    }
    return { data: Buffer.concat(chunks), etag: normalizeEtag(object.ETag) };
  }

  async write(path: string, data: Buffer, version: string | undefined): Promise<{ etag: string }> {
    if (data.length > Math.min(MAX_BYTES, this.maxFileSize)) throw new StorageOperationError(413, 'too_large', 'File exceeds size limit');
    const key = this.key(path);
    let head;
    try { head = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key })); }
    catch (error) { if (isMissing(error)) throw new StorageOperationError(version ? 409 : 404, version ? 'conflict' : 'not_found', 'File not found'); throw error; }
    if (!head.ETag) throw new Error('Storage object ETag is missing');
    if (version && normalizeEtag(head.ETag) !== normalizeEtag(version)) throw new StorageOperationError(409, 'conflict', 'File has changed');
    try {
      const result = await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: head.ContentType, Metadata: head.Metadata, ...(version ? { IfMatch: head.ETag } : {}) }));
      if (!result.ETag) throw new Error('Storage response ETag is missing');
      return { etag: normalizeEtag(result.ETag) };
    } catch (error) { if (status(error) === 412) throw new StorageOperationError(409, 'conflict', 'File has changed'); throw error; }
  }
}
