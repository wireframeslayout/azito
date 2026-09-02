import * as fs from 'fs';
import { Client as Ssh2Client } from 'ssh2';
import type { SshClient } from './SshClient';

const DEFAULT_TIMEOUT_MS = 300_000;

export class SftpService {
  constructor(private sshClient: SshClient) {}

  upload(sshHost: string, localPath: string, remotePath: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
    return new Promise((resolve, reject) => {
      const resolved = this.sshClient.resolveHost(sshHost);
      const conn = new Ssh2Client();
      const connectOpts = this.sshClient.buildConnectOpts(resolved);

      const timeout = setTimeout(() => {
        conn.end();
        reject(new Error('SFTP upload timed out'));
      }, timeoutMs);

      conn.on('ready', () => {
        conn.sftp((err, sftp) => {
          if (err) { clearTimeout(timeout); conn.end(); return reject(err); }
          const readStream = fs.createReadStream(localPath);
          const writeStream = sftp.createWriteStream(remotePath);
          writeStream.on('close', () => {
            clearTimeout(timeout);
            conn.end();
            resolve();
          });
          writeStream.on('error', (e: Error) => {
            clearTimeout(timeout);
            conn.end();
            reject(new Error(`SFTP upload failed: ${e.message}`));
          });
          readStream.on('error', (e: Error) => {
            clearTimeout(timeout);
            conn.end();
            reject(new Error(`SFTP upload read failed: ${e.message}`));
          });
          readStream.pipe(writeStream);
        });
      });

      conn.on('error', (err: Error) => { clearTimeout(timeout); reject(err); });
      conn.connect(connectOpts);
    });
  }

  download(sshHost: string, remotePath: string, localPath: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
    return new Promise((resolve, reject) => {
      const resolved = this.sshClient.resolveHost(sshHost);
      const conn = new Ssh2Client();
      const connectOpts = this.sshClient.buildConnectOpts(resolved);

      const timeout = setTimeout(() => {
        conn.end();
        reject(new Error('SFTP download timed out'));
      }, timeoutMs);

      conn.on('ready', () => {
        conn.sftp((err, sftp) => {
          if (err) { clearTimeout(timeout); conn.end(); return reject(err); }
          const readStream = sftp.createReadStream(remotePath);
          const writeStream = fs.createWriteStream(localPath);
          writeStream.on('close', () => {
            clearTimeout(timeout);
            conn.end();
            resolve();
          });
          readStream.on('error', (e: Error) => {
            clearTimeout(timeout);
            conn.end();
            reject(new Error(`SFTP download failed: ${e.message}`));
          });
          writeStream.on('error', (e: Error) => {
            clearTimeout(timeout);
            conn.end();
            reject(new Error(`SFTP download write failed: ${e.message}`));
          });
          readStream.pipe(writeStream);
        });
      });

      conn.on('error', (err: Error) => { clearTimeout(timeout); reject(err); });
      conn.connect(connectOpts);
    });
  }
}
