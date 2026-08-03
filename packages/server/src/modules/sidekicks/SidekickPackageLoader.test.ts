import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SidekickPackageLoader } from './SidekickPackageLoader';

function writePackage(
  rootDir: string,
  name: string,
  opts: {
    phase?: string;
    tags?: string;
    isDefault?: boolean;
    description?: string;
    body?: string;
    frontmatterName?: string;
  } = {},
): void {
  const dir = path.join(rootDir, name);
  fs.mkdirSync(dir, { recursive: true });
  // tags 指定時は tags: 形式で、それ以外は後方互換の phase: 形式で書く（両立はしない）。
  const tagOrPhaseLine = opts.tags !== undefined ? `tags: ${opts.tags}` : `phase: ${opts.phase ?? 'planning'}`;
  const fm = [
    '---',
    `name: ${opts.frontmatterName ?? name}`,
    `description: ${opts.description ?? `${name} description`}`,
    tagOrPhaseLine,
    `isDefault: ${opts.isDefault ?? false}`,
    '---',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `${fm}\n${opts.body ?? `${name} body`}`);
}

describe('SidekickPackageLoader', () => {
  let builtinDir: string;
  let userDir: string;

  beforeEach(() => {
    builtinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekicks-builtin-'));
    userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekicks-user-'));
  });

  afterEach(() => {
    fs.rmSync(builtinDir, { recursive: true, force: true });
    fs.rmSync(userDir, { recursive: true, force: true });
  });

  it('lists builtin packages when the user layer is empty', () => {
    writePackage(builtinDir, 'planning-default', { phase: 'planning', isDefault: true });
    const loader = new SidekickPackageLoader(builtinDir, userDir);
    const list = loader.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'planning-default', layer: 'builtin', overridesBuiltin: false });
  });

  it('treats a missing user directory as empty (no throw)', () => {
    writePackage(builtinDir, 'planning-default');
    fs.rmSync(userDir, { recursive: true, force: true });
    const loader = new SidekickPackageLoader(builtinDir, userDir);
    expect(loader.list()).toHaveLength(1);
  });

  it('user layer overrides a builtin package of the same name', () => {
    writePackage(builtinDir, 'planning-default', { description: 'builtin version' });
    writePackage(userDir, 'planning-default', { description: 'user version' });
    const loader = new SidekickPackageLoader(builtinDir, userDir);
    const list = loader.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ layer: 'user', overridesBuiltin: true, description: 'user version' });
  });

  it('merges distinct packages from both layers', () => {
    writePackage(builtinDir, 'planning-default');
    writePackage(userDir, 'my-custom-pkg', { phase: 'standalone' });
    const loader = new SidekickPackageLoader(builtinDir, userDir);
    const names = loader.list().map((p) => p.name).sort();
    expect(names).toEqual(['my-custom-pkg', 'planning-default']);
  });

  it('findByName resolves the merged (user-overridden) package', () => {
    writePackage(builtinDir, 'planning-default', { description: 'builtin' });
    writePackage(userDir, 'planning-default', { description: 'user' });
    const loader = new SidekickPackageLoader(builtinDir, userDir);
    expect(loader.findByName('planning-default')?.description).toBe('user');
  });

  it('findByName returns null for an unknown package', () => {
    const loader = new SidekickPackageLoader(builtinDir, userDir);
    expect(loader.findByName('does-not-exist')).toBeNull();
  });

  it('disables a package whose frontmatter name does not match its directory name', () => {
    writePackage(builtinDir, 'planning-default', { frontmatterName: 'something-else' });
    const loader = new SidekickPackageLoader(builtinDir, userDir);
    expect(loader.list()).toHaveLength(0);
  });

  it('disables a package with an invalid frontmatter name', () => {
    writePackage(builtinDir, 'Planning_Default', { frontmatterName: 'Planning_Default' });
    const loader = new SidekickPackageLoader(builtinDir, userDir);
    expect(loader.list()).toHaveLength(0);
  });

  it('disables a package with an invalid phase', () => {
    writePackage(builtinDir, 'weird-pkg', { phase: 'not-a-real-phase' });
    const loader = new SidekickPackageLoader(builtinDir, userDir);
    expect(loader.list()).toHaveLength(0);
  });

  it('findDefaultForTag returns the single isDefault package for a phase', () => {
    writePackage(builtinDir, 'planning-default', { phase: 'planning', isDefault: true });
    writePackage(builtinDir, 'other-planning', { phase: 'planning', isDefault: false });
    const loader = new SidekickPackageLoader(builtinDir, userDir);
    expect(loader.findDefaultForTag('planning')?.name).toBe('planning-default');
  });

  it('findDefaultForTag returns null when no default exists for a phase', () => {
    const loader = new SidekickPackageLoader(builtinDir, userDir);
    expect(loader.findDefaultForTag('testing')).toBeNull();
  });

  it('findDefaultForTag prefers the user layer when multiple isDefault packages exist', () => {
    writePackage(builtinDir, 'planning-default', { phase: 'planning', isDefault: true });
    writePackage(userDir, 'planning-custom', { phase: 'planning', isDefault: true });
    const loader = new SidekickPackageLoader(builtinDir, userDir);
    expect(loader.findDefaultForTag('planning')?.layer).toBe('user');
  });

  it('picks the name-ascending first package when multiple defaults exist in the same layer', () => {
    writePackage(builtinDir, 'zzz-planning', { phase: 'planning', isDefault: true });
    writePackage(builtinDir, 'aaa-planning', { phase: 'planning', isDefault: true });
    const loader = new SidekickPackageLoader(builtinDir, userDir);
    expect(loader.findDefaultForTag('planning')?.name).toBe('aaa-planning');
  });

  it('reports hasScripts/hasReferences based on subdirectory contents', () => {
    writePackage(builtinDir, 'pushing-default', { phase: 'pushing' });
    fs.mkdirSync(path.join(builtinDir, 'pushing-default', 'scripts'));
    fs.writeFileSync(path.join(builtinDir, 'pushing-default', 'scripts', 'push.sh'), '#!/bin/bash\n');
    const loader = new SidekickPackageLoader(builtinDir, userDir);
    const pkg = loader.findByName('pushing-default');
    expect(pkg?.hasScripts).toBe(true);
    expect(pkg?.hasReferences).toBe(false);
  });

  it('invalidates the cache when a SKILL.md is edited (mtime-based)', () => {
    writePackage(builtinDir, 'planning-default', { description: 'v1' });
    const loader = new SidekickPackageLoader(builtinDir, userDir);
    expect(loader.findByName('planning-default')?.description).toBe('v1');

    const skillPath = path.join(builtinDir, 'planning-default', 'SKILL.md');
    const futureMs = Date.now() + 5000;
    fs.writeFileSync(
      skillPath,
      '---\nname: planning-default\ndescription: v2\nphase: planning\nisDefault: false\n---\nbody',
    );
    fs.utimesSync(skillPath, new Date(futureMs), new Date(futureMs));

    expect(loader.findByName('planning-default')?.description).toBe('v2');
  });

  it('invalidates the directory listing cache when a new package is added', () => {
    const loader = new SidekickPackageLoader(builtinDir, userDir);
    expect(loader.list()).toHaveLength(0);

    const futureMs = Date.now() + 5000;
    writePackage(builtinDir, 'new-pkg');
    fs.utimesSync(builtinDir, new Date(futureMs), new Date(futureMs));

    expect(loader.list().map((p) => p.name)).toEqual(['new-pkg']);
  });

  it('invalidateCache() forces a fresh read even without an mtime change (same-tick writes)', () => {
    const loader = new SidekickPackageLoader(builtinDir, userDir);
    expect(loader.list()).toHaveLength(0);

    // Same-tick write: no fs.utimesSync bump, so the mtime-based cache alone would miss this.
    writePackage(builtinDir, 'new-pkg');
    loader.invalidateCache();

    expect(loader.list().map((p) => p.name)).toEqual(['new-pkg']);
  });

  describe('tags (Issue #263 Refine A)', () => {
    it('parses a comma-separated tags field', () => {
      writePackage(builtinDir, 'multi-tag', { tags: 'implementing, reviewing' });
      const loader = new SidekickPackageLoader(builtinDir, userDir);
      expect(loader.findByName('multi-tag')?.tags).toEqual(['implementing', 'reviewing']);
    });

    it('treats an empty tags field as no tags (standalone-equivalent)', () => {
      writePackage(builtinDir, 'no-tags', { tags: '' });
      const loader = new SidekickPackageLoader(builtinDir, userDir);
      expect(loader.findByName('no-tags')?.tags).toEqual([]);
    });

    it('treats a package with no tags/phase field at all as tags: []', () => {
      const dir = path.join(builtinDir, 'bare-pkg');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'SKILL.md'),
        '---\nname: bare-pkg\ndescription: bare\nisDefault: false\n---\nbody',
      );
      const loader = new SidekickPackageLoader(builtinDir, userDir);
      expect(loader.findByName('bare-pkg')?.tags).toEqual([]);
    });

    it('disables a package with an invalid tag format', () => {
      writePackage(builtinDir, 'bad-tag', { tags: 'Invalid_Tag' });
      const loader = new SidekickPackageLoader(builtinDir, userDir);
      expect(loader.list()).toHaveLength(0);
    });

    it('falls back to legacy phase: field when tags is absent (5-phase value)', () => {
      writePackage(builtinDir, 'legacy-pkg', { phase: 'reviewing' });
      const loader = new SidekickPackageLoader(builtinDir, userDir);
      expect(loader.findByName('legacy-pkg')?.tags).toEqual(['reviewing']);
    });

    it('falls back to legacy phase: standalone as tags: []', () => {
      writePackage(builtinDir, 'legacy-standalone', { phase: 'standalone' });
      const loader = new SidekickPackageLoader(builtinDir, userDir);
      expect(loader.findByName('legacy-standalone')?.tags).toEqual([]);
    });

    it('findDefaultForTag resolves by phase tag membership, not exact equality', () => {
      writePackage(builtinDir, 'multi-phase-default', { tags: 'implementing, reviewing', isDefault: true });
      const loader = new SidekickPackageLoader(builtinDir, userDir);
      expect(loader.findDefaultForTag('implementing')?.name).toBe('multi-phase-default');
      expect(loader.findDefaultForTag('reviewing')?.name).toBe('multi-phase-default');
    });
  });
});
