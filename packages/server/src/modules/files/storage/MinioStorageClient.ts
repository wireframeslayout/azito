import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  HeadBucketCommand,
  CreateBucketCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { StorageOperations } from './storageOperations';
import { StorageTextContent } from './storageTextContent';
import { StorageBinaryContent } from './storageBinaryContent';

export interface StorageSettings {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  region: string;
  maxFileSize: number;
  useSsl: boolean;
}

export interface StoredFile {
  key: string;
  originalName: string;
  size: number;
  lastModified: string;
}

export class MinioStorageClient {
  private client: S3Client | null = null;
  private currentConfig: string = '';

  private getClient(settings: StorageSettings): S3Client {
    const config = JSON.stringify([settings.endpoint, settings.region, settings.accessKey, settings.secretKey]);
    if (this.client && this.currentConfig === config) {
      return this.client;
    }
    this.client = new S3Client({
      endpoint: settings.endpoint,
      region: settings.region,
      credentials: {
        accessKeyId: settings.accessKey,
        secretAccessKey: settings.secretKey,
      },
      forcePathStyle: true,
    });
    this.currentConfig = config;
    return this.client;
  }

  async ensureBucket(settings: StorageSettings): Promise<void> {
    const s3 = this.getClient(settings);
    try {
      await s3.send(new HeadBucketCommand({ Bucket: settings.bucket }));
    } catch (error) {
      const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (e.name !== 'NotFound' && e.name !== 'NoSuchBucket' && e.$metadata?.httpStatusCode !== 404) throw error;
      await s3.send(new CreateBucketCommand({ Bucket: settings.bucket }));
    }
  }

  /** Reachability check for the status API: HeadBucket only, never creates the bucket. */
  async probe(settings: StorageSettings): Promise<void> {
    await this.getClient(settings).send(new HeadBucketCommand({ Bucket: settings.bucket }), { abortSignal: AbortSignal.timeout(2000) });
  }

  operations(settings: StorageSettings, projectId: number): StorageOperations {
    return new StorageOperations(this.getClient(settings), settings.bucket, projectId);
  }

  textContent(settings: StorageSettings, projectId: number): StorageTextContent {
    return new StorageTextContent(this.getClient(settings), settings.bucket, projectId, settings.maxFileSize);
  }

  binaryContent(settings: StorageSettings, projectId: number): StorageBinaryContent {
    return new StorageBinaryContent(this.getClient(settings), settings.bucket, projectId, settings.maxFileSize);
  }

  async upload(
    settings: StorageSettings,
    projectId: number,
    fileName: string,
    data: Buffer,
    contentType: string,
    prefix = '',
  ): Promise<StoredFile> {
    const s3 = this.getClient(settings);
    const key = `projects/${projectId}/${prefix}${fileName}`;

    await s3.send(new PutObjectCommand({
      Bucket: settings.bucket,
      Key: key,
      Body: data,
      ContentType: contentType,
    }));

    return {
      key,
      originalName: fileName.replace(/^\d+_/, ''),
      size: data.length,
      lastModified: new Date().toISOString(),
    };
  }

  async list(settings: StorageSettings, projectId: number): Promise<StoredFile[]> {
    const s3 = this.getClient(settings);
    const prefix = `projects/${projectId}/`;

    const result = await s3.send(new ListObjectsV2Command({
      Bucket: settings.bucket,
      Prefix: prefix,
      Delimiter: '/',
    }));

    return (result.Contents || []).map((obj) => ({
      key: obj.Key!,
      originalName: (obj.Key!.split('/').pop() || '').replace(/^\d+_/, ''),
      size: obj.Size || 0,
      lastModified: obj.LastModified?.toISOString() || '',
    }));
  }

  async delete(settings: StorageSettings, projectId: number, filename: string): Promise<void> {
    const s3 = this.getClient(settings);
    const key = `projects/${projectId}/${filename}`;

    await s3.send(new DeleteObjectCommand({
      Bucket: settings.bucket,
      Key: key,
    }));
  }

  getDirectUrl(settings: StorageSettings, projectId: number, filename: string): string {
    const key = `projects/${projectId}/${filename}`;
    const encodedKey = key.split('/').map(encodeURIComponent).join('/');
    return `${settings.endpoint}/${settings.bucket}/${encodedKey}`;
  }

  async getPresignedUrl(settings: StorageSettings, projectId: number, filename: string): Promise<string> {
    const s3 = this.getClient(settings);
    const key = `projects/${projectId}/${filename}`;
    return await getSignedUrl(s3, new GetObjectCommand({
      Bucket: settings.bucket,
      Key: key,
    }), { expiresIn: 3600 });
  }
}
