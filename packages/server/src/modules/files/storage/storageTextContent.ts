import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { extname } from 'path';
import { EXT_LANG } from '../fileLanguage';
import { MAX_FILE_SIZE } from '../FileBrowseService';
import { StorageOperationError, isMissing, validateStoragePath } from './storageOperations';

const normalizeEtag = (etag: string): string => etag.replace(/^"|"$/g, '');
const httpStatus = (error: unknown): number | undefined => (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
const notFound = (): StorageOperationError => new StorageOperationError(404, 'not_found', 'File not found');

export class StorageTextContent {
  constructor(private readonly s3: S3Client, private readonly bucket: string, private readonly projectId: number, private readonly maxFileSize: number) {}

  private key(path: string): string {
    return `projects/${this.projectId}/${validateStoragePath(path, false)}`;
  }

  async read(path: string): Promise<{ content: string; version: string; language: string }> {
    const key = this.key(path);
    let head;
    try { head = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key })); }
    catch (error) { throw isMissing(error) ? notFound() : error; }
    if (head.ContentLength === undefined || !head.ETag) throw new Error('Storage object metadata is incomplete');
    if (head.ContentLength > MAX_FILE_SIZE) throw new StorageOperationError(413, 'too_large', 'File exceeds 500 KiB');
    let object;
    try { object = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, IfMatch: head.ETag })); }
    catch (error) {
      if (httpStatus(error) === 412) throw new StorageOperationError(409, 'conflict', 'File changed while reading');
      throw isMissing(error) ? notFound() : error;
    }
    if (!object.ETag || normalizeEtag(object.ETag) !== normalizeEtag(head.ETag)) throw new StorageOperationError(409, 'conflict', 'File changed while reading');
    if (!object.Body) throw new Error('Storage object body is missing');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of object.Body as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > MAX_FILE_SIZE) throw new StorageOperationError(413, 'too_large', 'File exceeds 500 KiB');
      chunks.push(Buffer.from(chunk));
    }
    const data = Buffer.concat(chunks);
    if (data.includes(0)) throw new StorageOperationError(400, 'binary', 'File contains NUL bytes');
    let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); }
    catch { throw new StorageOperationError(400, 'invalid_utf8', 'File is not valid UTF-8'); }
    return { content, version: normalizeEtag(head.ETag), language: EXT_LANG[extname(path).toLowerCase()] || 'text' };
  }

  async write(path: string, content: string, version: string | undefined): Promise<{ version: string }> {
    const key = this.key(path);
    if (content.includes('\0')) throw new StorageOperationError(400, 'binary', 'File contains NUL bytes');
    const data = Buffer.from(content, 'utf-8');
    if (data.length > Math.min(MAX_FILE_SIZE, this.maxFileSize)) throw new StorageOperationError(413, 'too_large', 'File exceeds the configured size limit');
    let head;
    try { head = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key })); }
    catch (error) {
      if (!isMissing(error)) throw error;
      throw version !== undefined ? new StorageOperationError(409, 'conflict', 'File has changed') : notFound();
    }
    if (!head.ETag) throw new Error('Storage object ETag is missing');
    if (version !== undefined && normalizeEtag(head.ETag) !== normalizeEtag(version)) throw new StorageOperationError(409, 'conflict', 'File has changed');
    try {
      const result = await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: head.ContentType, Metadata: head.Metadata, ...(version !== undefined ? { IfMatch: head.ETag } : {}) }));
      if (!result.ETag) throw new Error('Storage response ETag is missing');
      return { version: normalizeEtag(result.ETag) };
    } catch (error) {
      if (httpStatus(error) === 412) throw new StorageOperationError(409, 'conflict', 'File has changed');
      throw error;
    }
  }
}
