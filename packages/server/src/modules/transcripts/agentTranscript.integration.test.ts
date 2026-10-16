// Integration: the hub's chat API reading a conversation log that lives on an agent server. The agent is the real
// agent process (src/agent/main.ts) on a temporary port, with a temporary token, HOME and TMUX_TMPDIR (so it can
// neither see the developer's ~/.claude nor touch their tmux). Nothing resident (daemon, dev hub) is involved.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { MuxPaneInfo } from '@azito/shared';
import transcriptsRoutes from './routes';
import { WindowSessionResolver } from './WindowSessionResolver';
import { HostTranscriptSourceProvider } from './sources/TranscriptSourceProvider';
import { LocalTranscriptSource } from './sources/LocalTranscriptSource';
import { ClaudeTranscriptSource } from './sources/ClaudeTranscriptSource';
import { CodexTranscriptSource } from './sources/CodexTranscriptSource';
import { AgentTransport } from '../servers/transport/AgentTransport';
import type { IServerRepository, ServerConfig } from '../servers/Server';
import type { IWindowRepository, Window } from '../windows/Window';
import type { ITaskRepository } from '../tasks/Task';
import type { MuxDriverRegistry } from '../tmux/MuxDriverRegistry';
import type { SessionCaptureService } from '../windows/SessionCaptureService';
import type { TransportFactory } from '../servers/transport/TransportFactory';
import type { InteractionMonitor } from '../notifications/InteractionMonitor';
import type { TranscriptPaneService } from './TranscriptPaneService';
import type { WindowInputService } from './WindowInputService';

const TOKEN = 'integration-token';
const SERVER_NAME = 'it-agent';
const SID_LIVE = '11111111-1111-1111-1111-111111111111';
const SID_STALE = '22222222-2222-2222-2222-222222222222';
const CWD = '/work/proj';
const SERVER_DIR = path.resolve(__dirname, '../../..');
const REPO_ROOT = path.resolve(SERVER_DIR, '../..');

function userLine(uuid: string, text: string): string {
  return JSON.stringify({ type: 'user', uuid, timestamp: new Date().toISOString(), cwd: CWD, message: { role: 'user', content: text } }) + '\n';
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(port: number, agent: ChildProcess): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (agent.exitCode !== null) throw new Error(`agent exited early (${agent.exitCode})`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('agent did not become healthy');
}

describe('chat API over a real agent process', () => {
  let tmp: string;
  let home: string;
  let sessionFile: string;
  let agent: ChildProcess;
  let fakeClaude: ChildProcess;
  let port: number;
  let app: FastifyInstance;
  let transport: AgentTransport;

  const server = { name: SERVER_NAME, type: 'agent', host: '127.0.0.1', agentToken: TOKEN, muxRuntime: 'system' } as unknown as ServerConfig;
  const window = (overrides: Partial<Window>): Window => ({
    id: 10, serverName: SERVER_NAME, tmuxTarget: 'main:0', workerType: 'claude', agentSessionId: null, taskId: null, paneLayout: null, ...overrides,
  }) as unknown as Window;
  let windows: Record<number, Window>;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-agent-it-'));
    home = path.join(tmp, 'home');
    const projectDir = path.join(home, '.claude', 'projects', 'proj');
    fs.mkdirSync(projectDir, { recursive: true });
    sessionFile = path.join(projectDir, `${SID_LIVE}.jsonl`);
    fs.writeFileSync(sessionFile, userLine('u1', 'first message on the agent host'));
    const stale = path.join(projectDir, `${SID_STALE}.jsonl`);
    fs.writeFileSync(stale, userLine('old1', 'an older conversation'));
    const hourAgo = (Date.now() - 60 * 60 * 1000) / 1000;
    fs.utimesSync(stale, hourAgo, hourAgo);

    // An "agent" process the gate can see in the agent host's `ps`: a process whose executable name is `claude`.
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    fs.symlinkSync(fs.realpathSync('/bin/sleep'), path.join(bin, 'claude'));
    fakeClaude = spawn(path.join(bin, 'claude'), ['300'], { stdio: 'ignore' });

    port = await freePort();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      TMUX_TMPDIR: path.join(tmp, 'tmux'),
      AZITO_AGENT_BIND: '127.0.0.1',
      AZITO_AGENT_TOKEN: TOKEN,
      PORT: String(port),
    };
    delete env.TMUX;
    delete env.TMUX_PANE;
    delete env.CLAUDE_CONFIG_DIR;
    delete env.CODEX_HOME;
    delete env.MISAO_SOCKET;
    fs.mkdirSync(path.join(tmp, 'tmux'));
    agent = spawn(path.join(REPO_ROOT, 'node_modules/.bin/tsx'), [path.join(SERVER_DIR, 'src/agent/main.ts')], { env, cwd: SERVER_DIR, stdio: 'ignore' });
    await waitForHealth(port, agent);

    transport = new AgentTransport('127.0.0.1', port, TOKEN, 'system', SERVER_NAME);
    // Local sources only name the agent types; the hub's own ~/.claude is never read for an agent server.
    const localSources = [
      new LocalTranscriptSource(new ClaudeTranscriptSource(path.join(tmp, 'hub-claude'))),
      new LocalTranscriptSource(new CodexTranscriptSource(path.join(tmp, 'hub-codex'))),
    ];
    const provider = new HostTranscriptSourceProvider(localSources, { getAgentTransport: () => transport });

    const pane: MuxPaneInfo = { paneId: '%1', sessionName: 'main', windowIndex: 0, windowName: 'w', paneIndex: 0, currentPath: CWD, currentCommand: 'claude' };
    const driver = {
      listAllPanes: async () => [pane],
      listWorkspaces: async () => [],
      panePidByHandle: async () => fakeClaude.pid ?? null,
    };
    const serverRepo = { findByName: (name: string) => (name === SERVER_NAME ? server : undefined) } as unknown as IServerRepository;
    const resolver = new WindowSessionResolver(
      { findById: () => null } as unknown as ITaskRepository,
      { resolve: () => driver } as unknown as MuxDriverRegistry,
      serverRepo,
      provider,
      { adoptResolvedSession: () => false } as unknown as SessionCaptureService,
      { getTransport: () => transport } as unknown as TransportFactory,
    );

    windows = {
      10: window({ id: 10, agentSessionId: SID_LIVE }),
      11: window({ id: 11, agentSessionId: SID_STALE }),
    };
    app = Fastify();
    await app.register(transcriptsRoutes, {
      sources: localSources,
      sourceProvider: provider,
      serverRepo,
      transcriptPaneService: {} as unknown as TranscriptPaneService,
      windowSessionResolver: resolver,
      windowInputService: {} as unknown as WindowInputService,
      windowRepo: { findById: (id: number) => windows[id] } as unknown as IWindowRepository,
      interactionMonitor: { isPending: () => false, getOpenedAt: () => undefined, clear: () => {} } as unknown as InteractionMonitor,
    });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    for (const child of [agent, fakeClaude]) {
      if (child && child.exitCode === null) child.kill('SIGTERM');
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('rejects requests to the agent that carry no (or the wrong) token', async () => {
    const attempts: Record<string, string>[] = [{}, { authorization: 'Bearer wrong' }];
    for (const headers of attempts) {
      const res = await fetch(`http://127.0.0.1:${port}/api/transcripts/claude/sessions`, { headers });
      expect(res.status).toBe(401);
    }
  });

  it('resolves the window\'s session from the agent, gated by the process list of the agent host', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/transcripts/resolve-window?windowId=10' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ resolved: true, agentType: 'claude', sessionId: SID_LIVE, paneId: '%1', agentDetected: true });
  });

  it('does not adopt a linked session that was last written before the agent process started', async () => {
    // Window 11 is linked to a session whose file was last written an hour ago, before the (fake) claude process
    // started: the gate refuses that link and the cwd match finds the live session instead.
    const res = await app.inject({ method: 'GET', url: '/api/transcripts/resolve-window?windowId=11' });
    expect(res.json()).toMatchObject({ resolved: true, sessionId: SID_LIVE });
  });

  it('reads the conversation from the agent host and picks up what is appended later, transferring only the new part', async () => {
    const first = await app.inject({ method: 'GET', url: `/api/transcripts/claude/${SID_LIVE}?windowId=10` });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as { entries: { uuid: string; blocks: { text: string }[] }[]; nextOffset: number };
    expect(firstBody.entries.map((e) => e.uuid)).toEqual(['u1']);
    expect(firstBody.entries[0].blocks[0].text).toBe('first message on the agent host');

    fs.appendFileSync(sessionFile, userLine('u2', 'appended later'));
    const diff = await app.inject({ method: 'GET', url: `/api/transcripts/claude/${SID_LIVE}?offset=${firstBody.nextOffset}&windowId=10` });
    const diffBody = diff.json() as { entries: { uuid: string }[]; nextOffset: number };
    expect(diffBody.entries.map((e) => e.uuid)).toEqual(['u2']);
    expect(diffBody.nextOffset).toBeGreaterThan(firstBody.nextOffset);
  });

  it('does not serve the hub\'s own conversation logs for a window on the agent', async () => {
    // The hub-side directory has the same session id with different content; it must never be returned.
    const hubProjects = path.join(tmp, 'hub-claude', 'proj');
    fs.mkdirSync(hubProjects, { recursive: true });
    fs.writeFileSync(path.join(hubProjects, `${SID_LIVE}.jsonl`), userLine('hub1', 'hub local content'));
    const res = await app.inject({ method: 'GET', url: `/api/transcripts/claude/${SID_LIVE}?windowId=10` });
    expect(res.body).not.toContain('hub local content');
  });

  it('answers 503 agent_unreachable once the agent is gone, without throwing', async () => {
    agent.kill('SIGTERM');
    await new Promise((resolve) => agent.once('exit', resolve));
    const res = await app.inject({ method: 'GET', url: `/api/transcripts/claude/${SID_LIVE}?offset=0&windowId=10` });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'agent_unreachable' });
  });
});
