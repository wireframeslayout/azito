import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import chatCommandsRoutes from './routes';
import { ChatCommandLoader } from './ChatCommandLoader';
import { createTokenVerifier } from '../servers/auth/tokenAuth';

const TOKEN = 'a'.repeat(64);

function writeFile(filePath: string, content: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(content));
}

describe('chatCommandsRoutes', () => {
  let dir: string;
  let builtinPath: string;
  let userPath: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-commands-routes-'));
    builtinPath = path.join(dir, 'builtin.json');
    userPath = path.join(dir, 'user.json');
    writeFile(builtinPath, {
      commands: [
        { name: 'model', description: 'switch model', agentTypes: ['claude'], type: 'select', options: [{ value: 'sonnet', label: 'Sonnet' }] },
        { name: 'compact', description: 'compact context', agentTypes: ['claude'], type: 'text' },
        { name: 'other', description: 'codex only', agentTypes: ['codex'], type: 'text' },
      ],
    });

    // 実運用と同じ「/api 全体を onRequest フックで認証する」構成を最小再現する
    // （buildServer.auth.test.ts と同じパターン）。
    const verifyUiToken = createTokenVerifier(TOKEN);
    app = Fastify();
    app.addHook('onRequest', async (request, reply) => {
      if (!request.url.startsWith('/api')) return;
      if (!verifyUiToken(request.headers.authorization)) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }
    });
    const chatCommandLoader = new ChatCommandLoader(builtinPath, userPath);
    await app.register(chatCommandsRoutes, { chatCommandLoader });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects requests without a valid token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/chat-commands?worker_type=claude' });
    expect(res.statusCode).toBe(401);
  });

  it('returns only commands matching worker_type', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/chat-commands?worker_type=claude',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { commands: { name: string }[] };
    expect(body.commands.map((c) => c.name)).toEqual(['compact', 'model']);
  });

  it('returns codex-only commands for worker_type=codex', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/chat-commands?worker_type=codex',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const body = res.json() as { commands: { name: string }[] };
    expect(body.commands.map((c) => c.name)).toEqual(['other']);
  });

  it('returns 400 when worker_type is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/chat-commands',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(400);
  });
});
