import { spawn, type ChildProcess } from 'child_process';
import crypto from 'crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { ProcessLock, ProcessLockBusyError } from './processLock';

/**
 * The lock between real processes on a real Windows named pipe: a second process cannot take what a first holds, two processes that
 * come at once get exactly one, and the OS frees it when the holder is killed (no stale lock to judge).
 */
const children: ChildProcess[] = [];

/** A process that takes the pipe like a lock holder (a `net` server answering with its pid) and says "held" once it listens. */
function startHolder(endpoint: string): Promise<ChildProcess> {
  const script = `const net=require('net');const s=net.createServer(c=>{c.on('error',()=>{});c.end(String(process.pid));});s.on('error',e=>{console.log(e.code);process.exit(2);});s.listen(${JSON.stringify(endpoint)},()=>console.log('held'));setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  children.push(child);
  return new Promise((resolve, reject) => {
    let out = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf-8');
      if (out.includes('held')) resolve(child);
      else if (/E[A-Z]+/.test(out)) reject(new Error(`the holder could not take ${endpoint}: ${out}`));
    });
    child.once('exit', (code) => reject(new Error(`the holder exited with ${code} before it held ${endpoint}: ${out}`)));
  });
}

const exited = (child: ChildProcess): Promise<void> => new Promise((resolve) => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('exit', () => resolve()); });

describe.skipIf(process.platform !== 'win32')('ProcessLock on a Windows named pipe, between processes', () => {
  afterEach(async () => {
    for (const child of children.splice(0)) {
      child.kill();
      await exited(child);
    }
  });

  it('is busy while another process holds the pipe, and free once that process is killed', async () => {
    const endpoint = `\\\\.\\pipe\\azito-lock-test-${crypto.randomBytes(6).toString('hex')}`;
    const holder = await startHolder(endpoint);
    const refused = await new ProcessLock(endpoint).run(async () => 'in').catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(ProcessLockBusyError);
    holder.kill('SIGKILL');
    await exited(holder);
    expect(await new ProcessLock(endpoint).run(async () => 'in')).toBe('in');
  });

  it('gives a process that is holding it a refusal for another process starting at the same moment, and the other way round', async () => {
    const endpoint = `\\\\.\\pipe\\azito-lock-test-${crypto.randomBytes(6).toString('hex')}`;
    // Two processes and this one all go for the pipe: exactly one holds it.
    const outcomes = await Promise.all([startHolder(endpoint).then(() => 'in', () => 'busy'), startHolder(endpoint).then(() => 'in', () => 'busy'), new ProcessLock(endpoint).run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return 'in';
    }).catch((err: unknown) => (err instanceof ProcessLockBusyError ? 'busy' : Promise.reject(err)))]);
    expect(outcomes.filter((o) => o === 'in')).toHaveLength(1);
  }, 60_000);
});
