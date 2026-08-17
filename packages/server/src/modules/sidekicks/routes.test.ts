import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import sidekicksRoutes from './routes';
import { SidekickPackageLoader, DEFAULT_BUILTIN_SIDEKICKS_DIR } from './SidekickPackageLoader';
import { SidekickPackageService } from './SidekickPackageService';
import type { ITaskPromptVarsResolver, TaskPromptVars } from './ITaskPromptVarsResolver';
import { UnitTypeLoader } from './UnitTypeLoader';

const FAKE_VARS: TaskPromptVars = {
  task: { title: 'Test Task', description: '', plan: '', targetBranch: '', pushTaskDescription: '', pushRules: '', pushOutput: '' },
  project: { sidekickPrompt: '', defaultBranch: 'main' },
  projectServer: { workingDirectory: '.', branch: '' },
  selfReview: { attempt: '1', maxAttempts: '2' },
  module: { reviewPerspectives: '', softwareDesignPrinciples: '', uiDesignPrinciples: '' },
};

function makeTaskPromptVarsResolver(overrides: Partial<ITaskPromptVarsResolver> = {}): ITaskPromptVarsResolver {
  return {
    resolve: (taskId: number) => {
      if (taskId === 999) throw new Error('Task not found: 999');
      return FAKE_VARS;
    },
    resolveDir: async (taskId: number, pkg) => {
      if (taskId === 999) throw new Error('Task not found: 999');
      return pkg.dir; // default: behaves like a local-server task (no remote sync involved)
    },
    ...overrides,
  };
}

function writePackage(rootDir: string, name: string, phase = 'planning'): void {
  const dir = path.join(rootDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} description\nphase: ${phase}\nisDefault: false\n---\n${name} body`,
  );
}

describe('sidekicksRoutes', () => {
  let builtinDir: string;
  let userDir: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    builtinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekicks-routes-builtin-'));
    userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekicks-routes-user-'));
    const loader = new SidekickPackageLoader(builtinDir, userDir);
    const sidekickService = new SidekickPackageService(loader, userDir);
    app = Fastify();
    await app.register(sidekicksRoutes, { sidekickService, taskPromptVarsResolver: makeTaskPromptVarsResolver(), unitTypeLoader: new UnitTypeLoader(builtinDir, userDir), detailAuth: { classes: [] }, listAuth: { classes: [] }, resolveAssignedSidekickNames: () => new Set<string>(), scopedAuthEnabled: true });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(builtinDir, { recursive: true, force: true });
    fs.rmSync(userDir, { recursive: true, force: true });
  });

  it('GET /api/sidekicks lists meta only (no body field)', async () => {
    writePackage(builtinDir, 'planning-default');
    const res = await app.inject({ method: 'GET', url: '/api/sidekicks' });
    expect(res.statusCode).toBe(200);
    const list = res.json();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('planning-default');
    expect(list[0]).not.toHaveProperty('body');
  });

  it('GET /api/sidekicks/:name returns the full package including body', async () => {
    writePackage(builtinDir, 'planning-default');
    const res = await app.inject({ method: 'GET', url: '/api/sidekicks/planning-default' });
    expect(res.statusCode).toBe(200);
    expect(res.json().body).toBe('planning-default body');
  });

  it('GET /api/sidekicks/:name returns 404 for an unknown package', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sidekicks/nope' });
    expect(res.statusCode).toBe(404);
  });

  it('POST /api/sidekicks scaffolds a package', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sidekicks',
      payload: { name: 'my-pkg', description: 'd', phase: 'standalone' },
    });
    expect(res.statusCode).toBe(201);
    expect(fs.existsSync(path.join(userDir, 'my-pkg', 'SKILL.md'))).toBe(true);
  });

  it('POST /api/sidekicks returns 400 when required fields are missing', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/sidekicks', payload: { name: 'x' } });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/sidekicks returns 400 (not 500) for a non-object JSON body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sidekicks',
      headers: { 'content-type': 'application/json' },
      payload: '"just a string"',
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/sidekicks returns 400 (not 500) for an array JSON body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sidekicks',
      headers: { 'content-type': 'application/json' },
      payload: '[]',
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/sidekicks returns 400 for malformed scripts entries', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sidekicks',
      payload: { name: 'x-pkg', description: 'd', phase: 'standalone', scripts: [{ content: 'no filename' }] },
    });
    expect(res.statusCode).toBe(400);
    expect(fs.existsSync(path.join(userDir, 'x-pkg'))).toBe(false);
  });

  it('PUT /api/sidekicks/:name returns 400 (not 500) when the body is not a JSON object', async () => {
    writePackage(builtinDir, 'planning-default');
    const res = await app.inject({
      method: 'PUT',
      url: '/api/sidekicks/planning-default',
      headers: { 'content-type': 'application/json' },
      payload: 'null',
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/sidekicks rejects path-traversal names (e.g. "../evil")', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sidekicks',
      payload: { name: '../evil', description: 'd', phase: 'standalone' },
    });
    expect(res.statusCode).toBe(400);
    expect(fs.existsSync(path.join(path.dirname(userDir), 'evil'))).toBe(false);
  });

  it('PUT /api/sidekicks/:name on a path-traversal name returns 400 without touching the filesystem', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/sidekicks/..%2F..%2Fevil',
      payload: { description: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PUT /api/sidekicks/:name updates a package (copy-on-write for builtin)', async () => {
    writePackage(builtinDir, 'planning-default');
    const res = await app.inject({
      method: 'PUT',
      url: '/api/sidekicks/planning-default',
      payload: { description: 'edited' },
    });
    expect(res.statusCode).toBe(200);
    expect(fs.existsSync(path.join(userDir, 'planning-default', 'SKILL.md'))).toBe(true);
  });

  it('PUT /api/sidekicks/:name accepts scripts and writes them under scripts/', async () => {
    writePackage(builtinDir, 'planning-default');
    const res = await app.inject({
      method: 'PUT',
      url: '/api/sidekicks/planning-default',
      payload: { scripts: [{ filename: 'run.sh', content: '#!/bin/bash\necho hi\n' }] },
    });
    expect(res.statusCode).toBe(200);
    const scriptPath = path.join(userDir, 'planning-default', 'scripts', 'run.sh');
    expect(fs.existsSync(scriptPath)).toBe(true);
    expect(fs.statSync(scriptPath).mode & 0o777).toBe(0o755);
  });

  it('PUT /api/sidekicks/:name returns 400 for malformed scripts entries', async () => {
    writePackage(builtinDir, 'planning-default');
    const res = await app.inject({
      method: 'PUT',
      url: '/api/sidekicks/planning-default',
      payload: { scripts: [{ content: 'no filename' }] },
    });
    expect(res.statusCode).toBe(400);
    expect(fs.existsSync(path.join(userDir, 'planning-default'))).toBe(false);
  });

  it('PUT /api/sidekicks/:name returns 404 for an unknown package', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/sidekicks/nope', payload: { description: 'x' } });
    expect(res.statusCode).toBe(404);
  });

  describe('tags (Issue #263 Refine A)', () => {
    it('POST /api/sidekicks accepts tags directly', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/sidekicks',
        payload: { name: 'tagged-pkg', description: 'd', tags: ['implementing', 'reviewing'] },
      });
      expect(res.statusCode).toBe(201);
      const detail = await app.inject({ method: 'GET', url: '/api/sidekicks/tagged-pkg' });
      expect(detail.json().tags).toEqual(['implementing', 'reviewing']);
    });

    it('POST /api/sidekicks still accepts a legacy phase field', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/sidekicks',
        payload: { name: 'legacy-pkg', description: 'd', phase: 'pushing' },
      });
      expect(res.statusCode).toBe(201);
      const detail = await app.inject({ method: 'GET', url: '/api/sidekicks/legacy-pkg' });
      expect(detail.json().tags).toEqual(['pushing']);
    });

    it('POST /api/sidekicks defaults to tags: [] when neither tags nor phase is given', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/sidekicks',
        payload: { name: 'untagged-pkg', description: 'd' },
      });
      expect(res.statusCode).toBe(201);
      const detail = await app.inject({ method: 'GET', url: '/api/sidekicks/untagged-pkg' });
      expect(detail.json().tags).toEqual([]);
    });

    it('POST /api/sidekicks returns 400 for isDefault: true with no phase tag', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/sidekicks',
        payload: { name: 'foo', description: 'd', tags: ['issue'], isDefault: true },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/phase tag/);
    });

    it('POST /api/sidekicks returns 400 when tags is not an array of strings', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/sidekicks',
        payload: { name: 'foo', description: 'd', tags: 'implementing' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('PUT /api/sidekicks/:name updates tags', async () => {
      writePackage(builtinDir, 'planning-default');
      const res = await app.inject({
        method: 'PUT',
        url: '/api/sidekicks/planning-default',
        payload: { tags: ['reviewing'] },
      });
      expect(res.statusCode).toBe(200);
      const detail = await app.inject({ method: 'GET', url: '/api/sidekicks/planning-default' });
      expect(detail.json().tags).toEqual(['reviewing']);
    });

    it('GET /api/sidekicks/:name?render=1 returns tags instead of phase', async () => {
      writePackage(builtinDir, 'planning-default');
      const res = await app.inject({ method: 'GET', url: '/api/sidekicks/planning-default?render=1' });
      expect(res.statusCode).toBe(200);
      expect(res.json().tags).toEqual(['planning']);
      expect(res.json()).not.toHaveProperty('phase');
    });
  });

  it('DELETE /api/sidekicks/:name returns 400 for a builtin-only package', async () => {
    writePackage(builtinDir, 'planning-default');
    const res = await app.inject({ method: 'DELETE', url: '/api/sidekicks/planning-default' });
    expect(res.statusCode).toBe(400);
  });

  it('DELETE /api/sidekicks/:name removes a user-layer package', async () => {
    await app.inject({ method: 'POST', url: '/api/sidekicks', payload: { name: 'my-pkg', description: 'd', phase: 'standalone' } });
    const res = await app.inject({ method: 'DELETE', url: '/api/sidekicks/my-pkg' });
    expect(res.statusCode).toBe(200);
    expect(fs.existsSync(path.join(userDir, 'my-pkg'))).toBe(false);
  });

  it('DELETE /api/sidekicks/:name returns 404 for an unknown package', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/sidekicks/nope' });
    expect(res.statusCode).toBe(404);
  });

  describe('GET /api/sidekicks/:name?render=1', () => {
    it('with task_id: expands task/project/module vars via the injected resolver', async () => {
      writePackage(builtinDir, 'planning-default');
      fs.writeFileSync(
        path.join(builtinDir, 'planning-default', 'SKILL.md'),
        '---\nname: planning-default\ndescription: d\nphase: planning\nisDefault: false\n---\nHello {{task.title}} in {{sidekick.name}}',
      );
      const res = await app.inject({ method: 'GET', url: '/api/sidekicks/planning-default?render=1&task_id=1' });
      expect(res.statusCode).toBe(200);
      expect(res.json().prompt).toBe('Hello Test Task in planning-default');
    });

    it('with task_id: propagates a "Task not found" error as 404', async () => {
      writePackage(builtinDir, 'planning-default');
      const res = await app.inject({ method: 'GET', url: '/api/sidekicks/planning-default?render=1&task_id=999' });
      expect(res.statusCode).toBe(404);
    });

    it('with task_id: returns 400 for a non-numeric task_id', async () => {
      writePackage(builtinDir, 'planning-default');
      const res = await app.inject({ method: 'GET', url: '/api/sidekicks/planning-default?render=1&task_id=abc' });
      expect(res.statusCode).toBe(400);
    });

    it('without task_id: expands only sidekick/module vars, keeping task/project vars literal', async () => {
      writePackage(builtinDir, 'planning-default');
      fs.writeFileSync(
        path.join(builtinDir, 'planning-default', 'SKILL.md'),
        '---\nname: planning-default\ndescription: d\nphase: planning\nisDefault: false\n---\n{{task.title}} / {{sidekick.name}}',
      );
      const res = await app.inject({ method: 'GET', url: '/api/sidekicks/planning-default?render=1' });
      expect(res.statusCode).toBe(200);
      expect(res.json().prompt).toBe('{{task.title}} / planning-default');
    });

    it('without task_id: works for a standalone package (no task context needed)', async () => {
      writePackage(builtinDir, 'my-standalone', 'standalone');
      const res = await app.inject({ method: 'GET', url: '/api/sidekicks/my-standalone?render=1' });
      expect(res.statusCode).toBe(200);
      expect(res.json().prompt).toBe('my-standalone body');
    });

    it('with task_id: uses resolveDir\'s result for {{sidekick.dir}} (e.g. a synced remote path)', async () => {
      writePackage(builtinDir, 'pushing-default');
      fs.writeFileSync(
        path.join(builtinDir, 'pushing-default', 'SKILL.md'),
        '---\nname: pushing-default\ndescription: d\nphase: pushing\nisDefault: false\n---\nrun {{sidekick.dir}}/scripts/push.sh',
      );
      app = Fastify();
      const loader = new SidekickPackageLoader(builtinDir, userDir);
      const sidekickService = new SidekickPackageService(loader, userDir);
      await app.register(sidekicksRoutes, {
        sidekickService,
        taskPromptVarsResolver: makeTaskPromptVarsResolver({
          resolveDir: async () => '~/.azito/sidekicks/pushing-default',
        }),
        unitTypeLoader: new UnitTypeLoader(builtinDir, userDir),
        detailAuth: { classes: [] },
        listAuth: { classes: [] },
        resolveAssignedSidekickNames: () => new Set<string>(),
        scopedAuthEnabled: true,
      });
      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/api/sidekicks/pushing-default?render=1&task_id=1' });
      expect(res.statusCode).toBe(200);
      expect(res.json().prompt).toBe('run ~/.azito/sidekicks/pushing-default/scripts/push.sh');
    });

    it('without render=1: returns the plain detail object (back-compat)', async () => {
      writePackage(builtinDir, 'planning-default');
      const res = await app.inject({ method: 'GET', url: '/api/sidekicks/planning-default' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveProperty('body');
      expect(res.json()).not.toHaveProperty('prompt');
    });

    // Issue #263 Refine D: standalone render (this endpoint) applies no execution
    // envelope at all — verify against the real builtin pushing-default package,
    // not a synthetic one, so a regression that re-adds protocol text to a real
    // body would be caught here.
    it('standalone render of the real builtin pushing-default contains no execution-protocol markers', async () => {
      app = Fastify();
      const loader = new SidekickPackageLoader(DEFAULT_BUILTIN_SIDEKICKS_DIR, userDir);
      const sidekickService = new SidekickPackageService(loader, userDir);
      await app.register(sidekicksRoutes, { sidekickService, taskPromptVarsResolver: makeTaskPromptVarsResolver(), unitTypeLoader: new UnitTypeLoader(builtinDir, userDir), detailAuth: { classes: [] }, listAuth: { classes: [] }, resolveAssignedSidekickNames: () => new Set<string>(), scopedAuthEnabled: true });
      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/api/sidekicks/pushing-default?render=1' });
      expect(res.statusCode).toBe(200);
      const { prompt } = res.json();
      expect(prompt).not.toMatch(/AZITO_DONE|AZITO_QUESTIONS|AZITO_TEST_FAILED|AZITO_PHASE_SUMMARY/);
      expect(prompt).not.toContain('<completion_signal>');
      expect(prompt).not.toContain('PHASE_COMPLETE');
      expect(prompt).not.toContain('QUESTIONS_JSON');
    });
  });
});
