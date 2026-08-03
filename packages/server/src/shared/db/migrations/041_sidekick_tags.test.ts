import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// migration 041 は FS のみを書き換え、DB は一切参照しないため（up の db 引数は未使用）、
// 039/040 のテストと異なり事前マイグレーションの再生は不要。
// USER_SIDEKICKS_DIR はモジュール読み込み時に AZITO_SIDEKICKS_DIR を解決する（Resolve at the
// Boundary）ため、039 のテストと同じく各テストで vi.resetModules() + 動的 import して
// beforeEach で設定した env を確実に反映させる。
async function loadMigration() {
  return import('./041_sidekick_tags.js');
}

function buildDb(): Database.Database {
  return new Database(':memory:');
}

function writePackage(userDir: string, name: string, frontmatterBody: string, body = `${name} body`): void {
  const dir = path.join(userDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\n${frontmatterBody}\n---\n${body}`);
}

describe('migration 041: rewrite user-layer SKILL.md phase: to tags:', () => {
  let userDir: string;

  beforeEach(() => {
    userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekicks-mig041-'));
    vi.resetModules();
    process.env.AZITO_SIDEKICKS_DIR = userDir;
  });

  afterEach(() => {
    delete process.env.AZITO_SIDEKICKS_DIR;
    fs.rmSync(userDir, { recursive: true, force: true });
  });

  it('is a no-op when the user sidekicks directory does not exist', async () => {
    fs.rmSync(userDir, { recursive: true, force: true });
    const m041 = await loadMigration();
    expect(() => m041.up(buildDb())).not.toThrow();
  });

  it('rewrites a legacy phase: field (5-phase value) to tags:', async () => {
    writePackage(userDir, 'my-pkg', 'name: my-pkg\ndescription: d\nphase: implementing\nisDefault: true');
    const m041 = await loadMigration();
    m041.up(buildDb());

    const content = fs.readFileSync(path.join(userDir, 'my-pkg', 'SKILL.md'), 'utf-8');
    expect(content).toContain('tags: implementing');
    expect(content).not.toMatch(/^phase:/m);
    expect(content).toContain('my-pkg body');
  });

  it('rewrites phase: standalone to an empty tags: value', async () => {
    writePackage(userDir, 'my-standalone', 'name: my-standalone\ndescription: d\nphase: standalone\nisDefault: false');
    const m041 = await loadMigration();
    m041.up(buildDb());

    const content = fs.readFileSync(path.join(userDir, 'my-standalone', 'SKILL.md'), 'utf-8');
    expect(content).toMatch(/^tags: ?$/m);
  });

  it('does not touch a package that already has a tags: field', async () => {
    writePackage(userDir, 'already-new', 'name: already-new\ndescription: d\ntags: implementing, reviewing\nisDefault: true');
    const before = fs.readFileSync(path.join(userDir, 'already-new', 'SKILL.md'), 'utf-8');

    const m041 = await loadMigration();
    m041.up(buildDb());

    const after = fs.readFileSync(path.join(userDir, 'already-new', 'SKILL.md'), 'utf-8');
    expect(after).toBe(before);
  });

  it('does not touch a package with neither tags: nor phase: (compat read already handles it as tags: [])', async () => {
    writePackage(userDir, 'bare', 'name: bare\ndescription: d\nisDefault: false');
    const before = fs.readFileSync(path.join(userDir, 'bare', 'SKILL.md'), 'utf-8');

    const m041 = await loadMigration();
    m041.up(buildDb());

    const after = fs.readFileSync(path.join(userDir, 'bare', 'SKILL.md'), 'utf-8');
    expect(after).toBe(before);
  });

  it('skips a package with an invalid legacy phase value without throwing', async () => {
    writePackage(userDir, 'bad-phase', 'name: bad-phase\ndescription: d\nphase: not-a-real-phase\nisDefault: false');
    const before = fs.readFileSync(path.join(userDir, 'bad-phase', 'SKILL.md'), 'utf-8');

    const m041 = await loadMigration();
    expect(() => m041.up(buildDb())).not.toThrow();

    const after = fs.readFileSync(path.join(userDir, 'bad-phase', 'SKILL.md'), 'utf-8');
    expect(after).toBe(before);
  });

  it('is idempotent (running twice does not change the result further)', async () => {
    writePackage(userDir, 'my-pkg', 'name: my-pkg\ndescription: d\nphase: pushing\nisDefault: true');
    const m041 = await loadMigration();
    m041.up(buildDb());
    const firstPass = fs.readFileSync(path.join(userDir, 'my-pkg', 'SKILL.md'), 'utf-8');

    m041.up(buildDb());
    const secondPass = fs.readFileSync(path.join(userDir, 'my-pkg', 'SKILL.md'), 'utf-8');

    expect(secondPass).toBe(firstPass);
  });

  it('demotes isDefault: true to false when converting phase: standalone (no phase tag left)', async () => {
    writePackage(userDir, 'default-standalone', 'name: default-standalone\ndescription: d\nphase: standalone\nisDefault: true');
    const m041 = await loadMigration();
    m041.up(buildDb());

    const content = fs.readFileSync(path.join(userDir, 'default-standalone', 'SKILL.md'), 'utf-8');
    expect(content).toMatch(/^tags: ?$/m);
    expect(content).toContain('isDefault: false');
    expect(content).not.toContain('isDefault: true');
  });

  it('keeps isDefault: true when the converted phase is a real phase tag', async () => {
    writePackage(userDir, 'default-phase', 'name: default-phase\ndescription: d\nphase: reviewing\nisDefault: true');
    const m041 = await loadMigration();
    m041.up(buildDb());

    const content = fs.readFileSync(path.join(userDir, 'default-phase', 'SKILL.md'), 'utf-8');
    expect(content).toContain('tags: reviewing');
    expect(content).toContain('isDefault: true');
  });

  it('strips quotes around the legacy phase value, matching the loader compat read', async () => {
    // frontmatterParser.ts の stripQuotes と同じ規約: "planning" / 'standalone' も有効値として解釈する
    writePackage(userDir, 'quoted-phase', 'name: quoted-phase\ndescription: d\nphase: "planning"\nisDefault: false');
    writePackage(userDir, 'quoted-standalone', "name: quoted-standalone\ndescription: d\nphase: 'standalone'\nisDefault: true");
    const m041 = await loadMigration();
    m041.up(buildDb());

    expect(fs.readFileSync(path.join(userDir, 'quoted-phase', 'SKILL.md'), 'utf-8')).toContain('tags: planning');
    const standaloneContent = fs.readFileSync(path.join(userDir, 'quoted-standalone', 'SKILL.md'), 'utf-8');
    expect(standaloneContent).toMatch(/^tags: ?$/m);
    expect(standaloneContent).toContain('isDefault: false'); // standalone + isDefault:true の降格も引用符付きで機能する
  });

  it('rewrites multiple packages independently', async () => {
    writePackage(userDir, 'pkg-a', 'name: pkg-a\ndescription: d\nphase: planning\nisDefault: true');
    writePackage(userDir, 'pkg-b', 'name: pkg-b\ndescription: d\nphase: testing\nisDefault: false');

    const m041 = await loadMigration();
    m041.up(buildDb());

    expect(fs.readFileSync(path.join(userDir, 'pkg-a', 'SKILL.md'), 'utf-8')).toContain('tags: planning');
    expect(fs.readFileSync(path.join(userDir, 'pkg-b', 'SKILL.md'), 'utf-8')).toContain('tags: testing');
  });
});
