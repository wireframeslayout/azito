import { z } from 'zod';
import type { IProjectRepository } from '../projects/Project';
import type { IProjectServerRepository } from '../projects/ProjectServer';
import type { IServerRepository } from '../servers/Server';
import type { TransportFactory } from '../servers/transport/TransportFactory';
import type { IStorageSettingsRepository } from './SqliteStorageSettingsRepository';
import type { MinioStorageClient } from './storage/MinioStorageClient';
import { validateStoragePath } from './storage/storageOperations';
import { FileBrowseService, MAX_DOWNLOAD_SIZE } from './FileBrowseService';
import { isHostPathContained } from '../../shared/os/hostPath';
import { signUrlToken, verifyUrlToken } from '../../shared/auth/signedUrl';

const targetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('server'), projectId: z.number().int().positive(), server: z.string().min(1), path: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('storage'), projectId: z.number().int().positive(), key: z.string().min(1) }).strict(),
]);
const MEDIA_TYPES: Record<string, string> = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4' };
export function mediaType(path: string): string { return MEDIA_TYPES[path.split('.').pop()?.toLowerCase() ?? ''] || 'application/octet-stream'; }
export type MediaTarget = z.infer<typeof targetSchema>;
export interface MediaDependencies {
  projectRepo: IProjectRepository;
  projectServerRepo: IProjectServerRepository;
  serverRepo: IServerRepository;
  transportFactory: TransportFactory;
  storageSettingsRepo: IStorageSettingsRepository;
  storageClient: MinioStorageClient;
  key: Buffer;
}

export class MediaService {
  private browse: FileBrowseService;
  constructor(private readonly deps: MediaDependencies) { this.browse = new FileBrowseService(deps.transportFactory); }

  parse(token: string): MediaTarget | null {
    const subject = verifyUrlToken(this.deps.key, token, 'media', Date.now());
    if (!subject) return null;
    try { const result = targetSchema.safeParse(JSON.parse(subject)); return result.success ? result.data : null; }
    catch { return null; }
  }

  async validate(target: MediaTarget): Promise<void> {
    if (!this.deps.projectRepo.findById(target.projectId)) throw new Error('Project not found');
    const path = target.kind === 'storage' ? target.key : target.path;
    const extension = path.split('.').pop()?.toLowerCase();
    if (!extension || !MEDIA_TYPES[extension]) throw new Error('Unsupported media');
    if (target.kind === 'storage') { this.storagePath(target); return; }
    const srv = this.deps.serverRepo.findByName(target.server);
    const association = this.deps.projectServerRepo.find(target.projectId, target.server);
    if (!srv || !association?.workingDirectory || /[\x00-\x1f]/.test(target.path)) throw new Error('Invalid media target');
    const ops = this.deps.transportFactory.getFileOps(srv);
    const [real, root] = await Promise.all([ops.realpath(target.path), ops.realpath(association.workingDirectory)]);
    if (!isHostPathContained(ops.platform, { target: real, allowedRoot: root })) throw new Error('Invalid media target');
  }

  async issue(target: MediaTarget): Promise<string> {
    await this.validate(target);
    if (target.kind === 'storage') await this.storage(target.projectId).statMedia(this.storagePath(target));
    else {
      const server = this.deps.serverRepo.findByName(target.server);
      if (!server) throw new Error('Server not found');
      const ops = this.deps.transportFactory.getFileOps(server);
      const stat = await ops.stat(await ops.realpath(target.path));
      if (!stat || stat.kind !== 'file' || stat.size > MAX_DOWNLOAD_SIZE) throw new Error('Invalid media file');
    }
    return `/api/media/${signUrlToken(this.deps.key, 'media', JSON.stringify(target), Date.now() + 600_000)}`;
  }

  storagePath(target: Extract<MediaTarget, { kind: 'storage' }>): string {
    const prefix = `projects/${target.projectId}/`;
    if (!target.key.startsWith(prefix)) throw new Error('Invalid storage key');
    return validateStoragePath(target.key.slice(prefix.length), false);
  }

  storage(projectId: number) { return this.deps.storageClient.binaryContent(this.deps.storageSettingsRepo.get(), projectId); }

  async serverFile(target: Extract<MediaTarget, { kind: 'server' }>) {
    const server = this.deps.serverRepo.findByName(target.server);
    if (!server) throw new Error('Server not found');
    const ops = this.deps.transportFactory.getFileOps(server);
    return this.browse.downloadFile(server, await ops.realpath(target.path));
  }
}
