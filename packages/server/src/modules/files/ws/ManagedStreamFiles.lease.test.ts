import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { ManagedStreamFiles, InvalidStreamFileError } from './ManagedStreamFiles';

describe('ManagedStreamFiles leases and limits', () => {
  let dir: string;
  let clock: number;
  const warnings: string[] = [];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-lease-'));
    clock = 1_000_000;
    warnings.length = 0;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const make = (maxFiles = 1024): ManagedStreamFiles =>
    new ManagedStreamFiles([dir], { maxFiles, leaseMs: 60_000, now: () => clock, logger: { warn: (m) => warnings.push(m) } });
  const file = (n: number): string => path.join(dir, `azito-pipe-${n}-1.log`);

  it('reclaims a registration nobody connected to within the lease, on the next registration', () => {
    const managed = make();
    managed.register(file(1));
    clock += 61_000;
    managed.register(file(2));
    expect(managed.isManaged(file(1))).toBe(false);
    expect(fs.existsSync(file(1))).toBe(false);
    expect(managed.isManaged(file(2))).toBe(true);
  });

  it('keeps a registration that has a connection, and restarts its clock when the connection ends', () => {
    const managed = make();
    managed.register(file(1));
    const detach = managed.attach(file(1));
    clock += 600_000;
    managed.register(file(2));
    expect(managed.isManaged(file(1))).toBe(true);
    detach();
    clock += 30_000;
    managed.register(file(3));
    expect(managed.isManaged(file(1))).toBe(true);
    clock += 31_000;
    managed.register(file(4));
    expect(managed.isManaged(file(1))).toBe(false);
  });

  it('at the limit, drops entries whose file is gone before evicting anything', () => {
    const managed = make(2);
    managed.register(file(1));
    managed.register(file(2));
    fs.unlinkSync(file(1));
    managed.register(file(3));
    expect(managed.isManaged(file(1))).toBe(false);
    expect(managed.isManaged(file(2))).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('at the limit, evicts the oldest idle registration and logs it', () => {
    const managed = make(2);
    managed.register(file(1));
    managed.register(file(2));
    managed.register(file(3));
    expect(managed.isManaged(file(1))).toBe(false);
    expect(managed.isManaged(file(3))).toBe(true);
    expect(warnings.join('\n')).toContain('evicting');
  });

  it('refuses, and logs, when every registration is in use', () => {
    const managed = make(1);
    managed.register(file(1));
    managed.attach(file(1));
    expect(() => managed.register(file(2))).toThrow(InvalidStreamFileError);
    expect(warnings.join('\n')).toContain('refusing');
  });

  it('does not block on a FIFO at the path; it refuses it', () => {
    if (process.platform === 'win32') return;
    const fifo = file(9);
    execFileSync('mkfifo', [fifo]);
    expect(() => make().register(fifo)).toThrow(InvalidStreamFileError);
  });

  it('re-registers an existing regular file without touching its content', () => {
    const managed = make();
    fs.writeFileSync(file(5), 'keep\n');
    managed.register(file(5));
    expect(fs.readFileSync(file(5), 'utf-8')).toBe('keep\n');
  });
});
