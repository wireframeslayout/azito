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
  private currentEndpoint: string = '';

  private getClient(settings: StorageSettings): S3Client {
    if (this.client && this.currentEndpoint === settings.endpoint) {
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
    this.currentEndpoint = settings.endpoint;
    return this.client;
  }

  async ensureBucket(settings: StorageSettings): Promise<void> {
    const s3 = this.getClient(settings);
    try {
      await s3.send(new HeadBucketCommand({ Bucket: settings.bucket }));
    } catch {
      await s3.send(new CreateBucketCommand({ Bucket: settings.bucket }));
    }
  }

  async upload(
    settings: StorageSettings,
    projectId: number,
    fileName: string,
    data: Buffer,
    contentType: string,
  ): Promise<StoredFile> {
    const s3 = this.getClient(settings);
    const key = `projects/${projectId}/${fileName}`;

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
    try {
      const s3 = this.getClient(settings);
      const key = `projects/${projectId}/${filename}`;
      return await getSignedUrl(s3, new GetObjectCommand({
        Bucket: settings.bucket,
        Key: key,
      }), { expiresIn: 3600 });
    } catch {
      return this.getDirectUrl(settings, projectId, filename);
    }
  }
}
