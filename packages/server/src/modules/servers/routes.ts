import type { FastifyPluginCallback } from 'fastify';
import { execSync } from 'child_process';
import os from 'os';
import type { IServerRepository, MuxRuntime } from './Server';
import type { TmuxClient } from '../tmux/TmuxClient';
import type { AgentInstaller, InstallProgress } from './agent-deploy/AgentInstaller';
import type { AgentBundler } from './agent-deploy/AgentBundler';
import type { TransportFactory } from './transport/TransportFactory';
import type { HarnessInstaller, HarnessInstallProgress, HarnessInstallResult } from './agent-deploy/HarnessInstaller';
import type { IProjectRepository } from '../projects/Project';
import type { IProjectServerRepository } from '../projects/ProjectServer';
import { parseTmuxVersion, parseNodeVersion, parseHarnessCheck, parseTailscaleCheck, parseChromiumInstall } from './installStatusParsers';
import { findChromiumBinaryCommand } from './agent-deploy/BrowserRuntimeInstaller';
import { stripTerminalArtifacts } from '../../shared/utils/stripTerminalArtifacts';
import type { TmuxInstaller } from './agent-deploy/TmuxInstaller';

// ─── Tailscale / network helpers ───

function getTailscaleDnsName(): string | null {
  try {
    const tsJson = execSync('tailscale status --self --json 2>/dev/null', { timeout: 5000 }).toString();
    const tsData = JSON.parse(tsJson);
    const dnsName = (tsData.Self?.DNSName || '').replace(/\.$/, '');
    return dnsName || null;
  } catch {
    return null;
  }
}

function getTailscaleIp(): string | null {
  try {
    return execSync('tailscale ip -4 2>/dev/null', { timeout: 5000 }).toString().trim() || null;
  } catch {
    return null;
  }
}

function getLanIps(): string[] {
  const results: string[] = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) results.push(iface.address);
    }
  }
  return results;
}

// ─── Types ───

export interface ServersRouteOptions {
  serverRepo: IServerRepository;
  tmux: TmuxClient;
  transportFactory: TransportFactory;
  agentInstaller?: AgentInstaller;
  agentBundler?: AgentBundler;
  harnessInstaller?: HarnessInstaller;
  tmuxInstaller?: TmuxInstaller;
  projectRepo?: IProjectRepository;
  projectServerRepo?: IProjectServerRepository;
  webhookToken: string;
  uiToken: string;
  harnessPrefix?: string;
}

// ─── Plugin ───

const serversRoutes: FastifyPluginCallback<ServersRouteOptions> = (fastify, opts, done) => {
  const { serverRepo, tmux, transportFactory, agentInstaller, agentBundler, harnessInstaller, tmuxInstaller, projectRepo, projectServerRepo, webhookToken, uiToken, harnessPrefix } = opts;

  // ── GET /api/servers ──
  fastify.get('/api/servers', async () => {
    // Bundle content hash (what deployed agents report at /health) — not the hub git
    // SHA. Read-only accessor: never triggers a build; null until the bundle exists.
    const hubBundleHash = agentBundler ? agentBundler.getBundleHashIfBuilt() : null;
    // isolationReport is a detail-only field (full JSON doctor result) — the
    // list endpoint exposes only the intent flag and last-check timestamp,
    // matching ServerConfig.isolationReport's own doc comment.
    return serverRepo.findAll().map(({ agentToken, isolationReport, ...rest }) => ({
      ...rest,
      hasAgentToken: agentToken != null,
      hubVersion: hubBundleHash,
    }));
  });

  // ── POST /api/servers ──
  fastify.post('/api/servers', async (request, reply) => {
    const { name, type, host, agentPort, agentToken, autoInstall, muxRuntime } = request.body as {
      name?: string;
      type?: string;
      host?: string;
      agentPort?: number;
      agentToken?: string;
      autoInstall?: boolean;
      muxRuntime?: string;
    };
    const validMuxRuntime = muxRuntime || undefined;
    if (validMuxRuntime && validMuxRuntime !== 'system' && validMuxRuntime !== 'managed')
      return reply.status(400).send({ error: 'muxRuntime must be "system" or "managed"' });
    if (!name) return reply.status(400).send({ error: 'Server name required' });
    if (!/^[\w.@ -]{1,64}$/.test(name)) return reply.status(400).send({ error: 'Invalid server name' });

    if (autoInstall && agentInstaller) {
      if (!host) return reply.status(400).send({ error: 'Host (user@host) required' });
      if (serverRepo.findByName(name))
        return reply.status(409).send({ error: 'Server already exists' });

      const steps: InstallProgress[] = [];
      const result = await agentInstaller.install(host, (p) => steps.push(p), validMuxRuntime);

      if (result.success) {
        serverRepo.create(name, 'agent', result.host, result.port, result.token, result.version, host, validMuxRuntime as MuxRuntime | undefined);
        return { ok: true, type: 'agent', steps, startMethod: result.startMethod };
      }

      return reply.status(500).send({ error: result.error, steps });
    }

    if (!type || !['local', 'agent'].includes(type))
      return reply.status(400).send({ error: 'Type must be "local" or "agent"' });
    if (type === 'agent') {
      if (!host) return reply.status(400).send({ error: 'Host required for agent servers' });
      if (!agentPort) return reply.status(400).send({ error: 'Port required for agent servers' });
      if (!agentToken) return reply.status(400).send({ error: 'Token required for agent servers' });
    }
    if (serverRepo.findByName(name))
      return reply.status(409).send({ error: 'Server already exists' });
    try {
      serverRepo.create(name, type, host, agentPort, agentToken, undefined, undefined, validMuxRuntime as MuxRuntime | undefined);
      return { ok: true };
    } catch (err: unknown) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── PUT /api/servers/:name ──
  fastify.put<{ Params: { name: string } }>(
    '/api/servers/:name',
    async (request, reply) => {
      const srv = serverRepo.findByName(request.params.name);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });
      const { type, host, agentPort, agentToken, sshHost, muxRuntime: putMux, isolationIntent } = request.body as {
        type?: string; host?: string; agentPort?: number; agentToken?: string; sshHost?: string; muxRuntime?: string; isolationIntent?: boolean;
      };
      const validPutMux = putMux || undefined;
      if (validPutMux && validPutMux !== 'system' && validPutMux !== 'managed')
        return reply.status(400).send({ error: 'muxRuntime must be "system" or "managed"' });
      // isolation_intent is only meaningful for agent servers (Issue #29
      // design v2): a "local" server always shares the hub process's own
      // credential store, so declaring it "isolated" would be a lie the
      // credential-distribution gates (TaskPaneEnvironmentService,
      // HarnessInstaller) could never actually honor. Reject at the API
      // boundary rather than silently accepting and ignoring it.
      if (isolationIntent !== undefined) {
        const effectiveType = (type || srv.type) as 'local' | 'agent';
        if (effectiveType !== 'agent')
          return reply.status(400).send({ error: 'isolationIntent is only settable for agent servers' });
      }
      try {
        serverRepo.update(
          request.params.name,
          type || srv.type,
          host ?? srv.host ?? undefined,
          agentPort ?? srv.agentPort ?? undefined,
          agentToken ?? srv.agentToken ?? undefined,
          sshHost ?? srv.sshHost ?? undefined,
          (validPutMux as MuxRuntime | undefined) ?? srv.muxRuntime,
        );
        if (isolationIntent !== undefined) {
          serverRepo.updateIsolationIntent(request.params.name, isolationIntent);
        }
        transportFactory.invalidate(request.params.name);
        return { ok: true };
      } catch (err: unknown) {
        return reply.status(500).send({ error: (err as Error).message });
      }
    },
  );

  // ── POST /api/servers/:name/agent/install ──
  fastify.post<{ Params: { name: string } }>(
    '/api/servers/:name/agent/install',
    async (request, reply) => {
      if (!agentInstaller) return reply.status(501).send({ error: 'Agent installer not available' });

      const srv = serverRepo.findByName(request.params.name);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });

      const sshHost = srv.sshHost || srv.host;
      if (!sshHost) return reply.status(400).send({ error: 'No SSH host configured for this server' });

      const steps: InstallProgress[] = [];
      const result = await agentInstaller.install(sshHost, (p) => steps.push(p), srv.muxRuntime);

      if (result.success) {
        serverRepo.update(srv.name, 'agent', result.host, result.port, result.token, sshHost, srv.muxRuntime);
        serverRepo.updateAgentVersion(srv.name, result.version);
        transportFactory.invalidate(srv.name);
        return { ok: true, steps, startMethod: result.startMethod };
      }

      return reply.status(500).send({ error: result.error, steps });
    },
  );

  // ── POST /api/servers/:name/harness/install ──
  fastify.post<{ Params: { name: string } }>(
    '/api/servers/:name/harness/install',
    async (request, reply) => {
      if (!harnessInstaller) return reply.status(501).send({ error: 'Harness installer not available' });

      const srv = serverRepo.findByName(request.params.name);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });

      const { azito_url } = request.body as { azito_url?: string };

      if (azito_url && !/^https?:\/\/[\w.:\-[\]]+\/?$/.test(azito_url)) {
        return reply.status(400).send({ error: 'Invalid azito_url format' });
      }

      const steps: HarnessInstallProgress[] = [];
      let result: HarnessInstallResult;
      const installOptions = { azitoUrl: azito_url, webhookToken, uiToken, serverName: srv.name, prefix: harnessPrefix, isolationIntent: srv.isolationIntent };

      if (srv.type === 'local') {
        result = await harnessInstaller.installLocal(installOptions);
      } else {
        const sshHost = srv.sshHost || srv.host;
        if (!sshHost) return reply.status(400).send({ error: 'No SSH host configured for this server' });
        result = await harnessInstaller.install(sshHost, installOptions, (p) => steps.push(p));
      }

      if (!result.success) {
        return reply.status(500).send({ ok: false, steps: result.steps, error: result.error });
      }

      return { ok: true, steps: result.steps };
    },
  );

  // ── DELETE /api/servers/:name ──
  fastify.delete<{ Params: { name: string } }>(
    '/api/servers/:name',
    async (request, reply) => {
      const srv = serverRepo.findByName(request.params.name);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });
      try {
        serverRepo.delete(request.params.name);
        return { ok: true };
      } catch (err: unknown) {
        return reply.status(500).send({ error: (err as Error).message });
      }
    },
  );

  // ── GET /api/servers/:name/status ──
  fastify.get<{ Params: { name: string } }>(
    '/api/servers/:name/status',
    async (request, reply) => {
      const srv = serverRepo.findByName(request.params.name);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });

      try {
        // Bundle content hash (what agents report at /health), read without triggering
        // a build — this route is polled frequently and must stay cheap. Null (bundle
        // not built yet) keeps the pre-existing "unknown hub version" semantics.
        const tmuxVersionCmd = srv.muxRuntime === 'managed'
          ? '$HOME/.azito/tmux/bin/tmux -L azito -f $HOME/.azito/tmux/azito.conf -V'
          : 'tmux -V';
        const hubBundleHash = agentBundler ? agentBundler.getBundleHashIfBuilt() : null;
        if (srv.type === 'agent') {
          try {
            const res = await fetch(`http://${srv.host}:${srv.agentPort}/health`, { signal: AbortSignal.timeout(5000) });
            if (!res.ok) return { status: 'offline' as const, tmux: false, message: `Agent returned ${res.status}` };
            const health = await res.json() as { version: string; pid: number; uptime: number };
            const versionMatch = hubBundleHash ? health.version === hubBundleHash : true;
            let tmuxAvailable = false;
            let tmuxVersion = '';
            try {
              const { stdout } = await tmux.execCommand(srv, tmuxVersionCmd);
              tmuxAvailable = true;
              tmuxVersion = stdout.trim();
            } catch { /* tmux not found on agent */ }
            return {
              status: 'online' as const,
              tmux: tmuxAvailable,
              tmuxVersion,
              agentVersion: health.version,
              hubVersion: hubBundleHash,
              versionMatch,
              message: tmuxAvailable ? undefined : 'tmux not found on agent server',
            };
          } catch (err: unknown) {
            return { status: 'offline' as const, tmux: false, message: `Agent unreachable: ${(err as Error).message}` };
          }
        } else {
          // Check if tmux is available locally
          let tmuxAvailable = false;
          let tmuxVersion = '';
          try {
            const { stdout } = await tmux.execCommand(srv, tmuxVersionCmd);
            tmuxAvailable = true;
            tmuxVersion = stdout.trim();
          } catch { /* tmux not found */ }
          return { status: 'online' as const, tmux: tmuxAvailable, tmuxVersion, message: tmuxAvailable ? undefined : 'tmux not found' };
        }
      } catch (err: unknown) {
        return { status: 'error' as const, tmux: false, message: (err as Error).message };
      }
    },
  );

  // ── GET /api/servers/:name/install-status ──
  fastify.get<{ Params: { name: string } }>(
    '/api/servers/:name/install-status',
    async (request, reply) => {
      const srv = serverRepo.findByName(request.params.name);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });

      const transport = transportFactory.getTransport(srv);

      const checkTmux = async () => {
        try {
          const cmd = srv.muxRuntime === 'managed'
            ? '$HOME/.azito/tmux/bin/tmux -L azito -f $HOME/.azito/tmux/azito.conf -V'
            : 'tmux -V';
          const r = await transport.exec(cmd);
          return { ...parseTmuxVersion(stripTerminalArtifacts(r.stdout), r.code), mode: srv.muxRuntime };
        } catch (err: unknown) {
          return { installed: false, detail: (err as Error).message, mode: srv.muxRuntime };
        }
      };

      const checkNode = async () => {
        try {
          const r = await transport.exec('node --version');
          return parseNodeVersion(stripTerminalArtifacts(r.stdout));
        } catch (err: unknown) {
          return { installed: false, detail: (err as Error).message };
        }
      };

      const checkHarness = async () => {
        try {
          const r = await transport.exec('ls -d ~/.claude/skills/azt-* 2>/dev/null | head -1');
          return parseHarnessCheck(stripTerminalArtifacts(r.stdout));
        } catch (err: unknown) {
          return { installed: false, detail: (err as Error).message };
        }
      };

      const checkTailscale = async () => {
        try {
          const r = await transport.exec('tailscale ip -4');
          return parseTailscaleCheck(stripTerminalArtifacts(r.stdout));
        } catch (err: unknown) {
          return { installed: false, detail: (err as Error).message };
        }
      };

      const checkChromium = async (osName: string) => {
        try {
          const r = await transport.exec(findChromiumBinaryCommand(osName));
          return parseChromiumInstall(stripTerminalArtifacts(r.stdout));
        } catch (err: unknown) {
          return { installed: false, detail: (err as Error).message };
        }
      };

      const checkAgent = async () => {
        try {
          const res = await fetch(`http://${srv.host}:${srv.agentPort}/health`, { signal: AbortSignal.timeout(5000) });
          if (!res.ok) return { installed: false, detail: `Agent returned ${res.status}` };
          const health = await res.json() as { version: string };
          // Bundle content hash comparison (see /status route); undefined when the
          // local bundle hasn't been built — matches the previous null-hubSha handling.
          const hubBundleHash = agentBundler ? agentBundler.getBundleHashIfBuilt() : null;
          const versionMatch = hubBundleHash ? health.version === hubBundleHash : undefined;
          return { installed: true, version: health.version, versionMatch };
        } catch (err: unknown) {
          return { installed: false, detail: (err as Error).message };
        }
      };

      const isRemote = srv.type === 'agent';
      const osName = (await transport.exec('uname -s')).stdout.trim();

      const [tmuxResult, nodeResult, harnessResult, tailscaleResult, agentResult, chromiumResult] = await Promise.all([
        checkTmux(),
        checkNode(),
        checkHarness(),
        isRemote ? checkTailscale() : null,
        srv.type === 'agent' ? checkAgent() : null,
        checkChromium(osName),
      ]);

      const result: Record<string, unknown> = {
        tmux: tmuxResult,
        node: nodeResult,
        aztHarness: harnessResult,
      };
      if (tailscaleResult) result.tailscale = tailscaleResult;
      if (agentResult) result.agent = agentResult;
      if (chromiumResult) result.chromium = chromiumResult;

      return result;
    },
  );

  // ── POST /api/servers/:name/install-tmux ──
  fastify.post<{ Params: { name: string } }>(
    '/api/servers/:name/install-tmux',
    async (request, reply) => {
      if (!tmuxInstaller) return reply.status(501).send({ error: 'Tmux installer not available' });
      const srv = serverRepo.findByName(request.params.name);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });
      if (srv.muxRuntime !== 'managed') return reply.status(400).send({ error: 'Only managed mode supports tmux installation' });
      const transport = transportFactory.getTransport(srv);
      const result = await tmuxInstaller.install(transport);
      if (!result.success) return reply.status(500).send({ error: result.error });
      return { ok: true, version: result.version };
    },
  );

  // ── POST /api/servers/:name/install-browser-runtime ──
  fastify.post<{ Params: { name: string } }>(
    '/api/servers/:name/install-browser-runtime',
    async (request, reply) => {
      const srv = serverRepo.findByName(request.params.name);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });
      const transport = transportFactory.getTransport(srv);
      const { BrowserRuntimeInstaller } = await import('./agent-deploy/BrowserRuntimeInstaller.js');
      const installer = new BrowserRuntimeInstaller();
      const result = await installer.install(transport);
      if (!result.success) return reply.status(500).send({ error: result.error, warning: result.warning });
      return { ok: true, chromiumVersion: result.chromiumVersion, fontInstalled: result.fontInstalled, warning: result.warning };
    },
  );

  // ── POST /api/servers/:name/apply-tmux-config ──
  fastify.post<{ Params: { name: string } }>(
    '/api/servers/:name/apply-tmux-config',
    async (request, reply) => {
      const srv = serverRepo.findByName(request.params.name);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });
      const transport = transportFactory.getTransport(srv);
      const { buildApplyTmuxConfigCommands } = await import('./agent-deploy/TmuxInstaller.js');
      const commands = buildApplyTmuxConfigCommands('$HOME');
      for (const cmd of commands) {
        await transport.exec(cmd);
      }
      return { ok: true, applied: true };
    },
  );

  // ── GET /api/servers/:name/branches ──
  fastify.get<{ Params: { name: string }; Querystring: { q?: string; project_id?: string; working_directory?: string } }>(
    '/api/servers/:name/branches',
    async (request, reply) => {
      const srv = serverRepo.findByName(request.params.name);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });

      const q = (request.query.q || '').trim().toLowerCase();
      const projectId = request.query.project_id ? parseInt(request.query.project_id, 10) : NaN;

      let workingDir: string | null | undefined = request.query.working_directory || undefined;
      if (!workingDir && !isNaN(projectId) && projectRepo && projectServerRepo) {
        const projectServer = projectServerRepo.find(projectId, request.params.name);
        workingDir = projectServer?.workingDirectory;
      }

      if (!workingDir) return { branches: [] };

      try {
        const safeDir = workingDir.replace(/'/g, "'\\''");
        const cmd = `cd '${safeDir}' && git branch -a --format='%(refname:short)' 2>/dev/null`;
        const result = await tmux.execCommand(srv, cmd);
        const lines = stripTerminalArtifacts(result.stdout).trim().split('\n').filter(Boolean);

        const seen = new Set<string>();
        const branches: string[] = [];
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'HEAD' || trimmed.endsWith('/HEAD')) continue;
          const name = trimmed.startsWith('origin/') ? trimmed.slice('origin/'.length) : trimmed;
          if (seen.has(name)) continue;
          seen.add(name);
          if (!q || name.toLowerCase().startsWith(q)) branches.push(name);
          if (branches.length >= 20) break;
        }

        return { branches };
      } catch {
        return { branches: [] };
      }
    },
  );

  // ── GET /api/servers/:name/editor-uri ──
  fastify.get<{ Params: { name: string }; Querystring: { path?: string; editor?: string } }>(
    '/api/servers/:name/editor-uri',
    async (request, reply) => {
      const srv = serverRepo.findByName(request.params.name);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });

      const filePath = (request.query.path || '').trim();
      if (!filePath) return reply.status(400).send({ error: 'path query parameter required' });

      const editor = (request.query.editor || '').trim();
      if (!editor || !['vscode', 'zed'].includes(editor)) {
        return reply.status(400).send({ error: 'editor must be "vscode" or "zed"' });
      }

      // Resolve SSH host: for SSH servers use configured host, for local use Tailscale hostname
      let sshHost: string;
      if (srv.type === 'agent' && srv.host) {
        sshHost = srv.host.replace(/:.*$/, '');
      } else {
        const tsHost = await getTailscaleDnsName();
        try {
          if (!tsHost) throw new Error('tailscale DNS name unavailable');
          const user = execSync('whoami', { timeout: 2000 }).toString().trim();
          sshHost = `${user}@${tsHost}`;
        } catch {
          sshHost = `${process.env.USER || 'user'}@${os.hostname()}`;
        }
      }

      const pathMod = await import('path');
      const folderPath = pathMod.dirname(filePath);

      let uri: string;
      if (editor === 'vscode') {
        uri = `vscode://vscode-remote/ssh-remote+${sshHost}${folderPath}`;
      } else {
        uri = `zed://ssh/${sshHost}${folderPath}`;
      }

      return { uri };
    },
  );

  // ── GET /api/server-info/base-urls ──
  fastify.get('/api/server-info/base-urls', () => {
    const port = process.env.PORT || '3001';
    const candidates: { label: string; url: string }[] = [];

    const dnsName = getTailscaleDnsName();
    const tsIp = getTailscaleIp();

    if (dnsName) candidates.push({ label: 'Tailscale (DNS)', url: `http://${dnsName}:${port}` });
    if (tsIp) candidates.push({ label: 'Tailscale (IP)', url: `http://${tsIp}:${port}` });

    for (const ip of getLanIps()) {
      candidates.push({ label: `LAN (${ip})`, url: `http://${ip}:${port}` });
    }

    return { candidates };
  });

  // ── DELETE /api/servers/:name/ssh-fingerprint ──
  fastify.delete<{ Params: { name: string } }>(
    '/api/servers/:name/ssh-fingerprint',
    async (request, reply) => {
      const srv = serverRepo.findByName(request.params.name);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });
      serverRepo.clearFingerprint(request.params.name);
      return { ok: true };
    },
  );

  done();
};

export default serversRoutes;
