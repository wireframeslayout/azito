import type { FastifyPluginCallback } from 'fastify';
import type { WebSocket } from 'ws';
import WsClient from 'ws';
import type { SqliteServerRepository } from '../servers/SqliteServerRepository';
import type { ServerConfig } from '../servers/Server';
import type { BrowserSessionManager } from './BrowserSessionManager';
import { createBufferedMessageRelay, messageByteSize } from '../../shared/utils/BufferedMessageRelay';

export interface DevtoolsRouteOptions {
  serverRepo: SqliteServerRepository;
  browserSessionManager: BrowserSessionManager;
}

async function fetchAgentPageTarget(srv: ServerConfig, groupId: string, tabId: string): Promise<string | null> {
  if (!srv.host || !srv.agentPort) return null;
  const authHeader = srv.agentToken ? `Bearer ${srv.agentToken}` : undefined;
  try {
    const res = await fetch(
      `http://${srv.host}:${srv.agentPort}/api/browser/page-target?page=${encodeURIComponent(tabId)}&group=${encodeURIComponent(groupId)}`,
      authHeader ? { headers: { authorization: authHeader } } : undefined,
    );
    if (!res.ok) return null;
    const body = await res.json() as { targetId?: string };
    return body.targetId ?? null;
  } catch {
    return null;
  }
}

const revCache = new Map<string, { value: string; expiresAt: number }>();

async function fetchRevFromUrl(versionUrl: string, authHeader?: string): Promise<string> {
  const res = await fetch(versionUrl, authHeader ? { headers: { authorization: authHeader } } : undefined);
  const version = await res.json() as { 'WebKit-Version': string };
  const rev = version['WebKit-Version']?.match(/@([0-9a-f]+)\)?\s*$/i)?.[1];
  if (!rev) throw new Error('Could not resolve DevTools frontend revision from WebKit-Version');
  return rev;
}

async function getDevtoolsRev(srv: ServerConfig | null): Promise<string> {
  const key = srv?.type === 'agent' ? `agent:${srv.name}` : 'local';
  const cached = revCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.value;

  let rev: string;
  if (srv?.type === 'agent') {
    if (!srv.host || !srv.agentPort) throw new Error('Agent server host/port not configured');
    const authHeader = srv.agentToken ? `Bearer ${srv.agentToken}` : undefined;
    rev = await fetchRevFromUrl(`http://${srv.host}:${srv.agentPort}/api/browser/version`, authHeader);
  } else {
    rev = await fetchRevFromUrl('http://127.0.0.1:9222/json/version');
  }

  revCache.set(key, { value: rev, expiresAt: Date.now() + 60_000 });
  return rev;
}

const devtoolsRoutes: FastifyPluginCallback<DevtoolsRouteOptions> = (fastify, opts, done) => {
  const { serverRepo, browserSessionManager } = opts;

  fastify.get<{ Querystring: { server?: string; page?: string; group?: string } }>('/api/browser/devtools', async (request, reply) => {
    const serverName = request.query.server;
    if (!serverName) return reply.status(400).send({ error: 'server query parameter required' });
    // A caller that explicitly passes `page` wants that specific tab; falling
    // back to "whatever /json/list returns first" would silently connect the
    // DevTools session to a different tab. Only legacy requests (no `page` at
    // all) get the first-page fallback below.
    const explicitPageId = request.query.page && /^[A-Za-z0-9_-]{1,64}$/.test(request.query.page)
      ? request.query.page
      : undefined;
    const isLegacyRequest = request.query.page === undefined;
    const pageId = explicitPageId ?? 'default';
    const groupId = request.query.group && /^[A-Za-z0-9_-]{1,64}$/.test(request.query.group)
      ? request.query.group
      : 'default';

    try {
      const srv = serverRepo.findByName(serverName);

      // Prefer the specific page's CDP targetId (multi-tab support); fall back to
      // the first page target from /json/list only for legacy (page-less) requests.
      let targetId: string | null = null;
      if (srv?.type === 'agent') {
        targetId = await fetchAgentPageTarget(srv, groupId, pageId);
      } else {
        const session = browserSessionManager.getStatus(serverName).running
          ? (await browserSessionManager.getOrCreate(serverName)) : null;
        targetId = session?.getPage(groupId, pageId)?.targetId ?? null;
      }

      if (!targetId && !isLegacyRequest) {
        return reply.status(404).send({ error: 'page target not found' });
      }

      if (!targetId) {
        let targetsUrl = 'http://127.0.0.1:9222/json/list';
        let authHeader: string | undefined;
        if (srv?.type === 'agent') {
          if (!srv.host || !srv.agentPort) return reply.status(400).send({ error: 'Agent server host/port not configured' });
          targetsUrl = `http://${srv.host}:${srv.agentPort}/api/browser/targets`;
          if (srv.agentToken) authHeader = `Bearer ${srv.agentToken}`;
        }
        const res = await fetch(targetsUrl, authHeader ? { headers: { authorization: authHeader } } : undefined);
        const targets = await res.json() as { id: string; type: string }[];
        const page = targets.find(t => t.type === 'page');
        if (!page) return reply.status(404).send({ error: 'No page target found' });
        targetId = page.id;
      }

      // The Vite dev proxy (packages/frontend/vite.config.ts) runs with
      // changeOrigin:true, which rewrites the Host header to the proxy
      // target (localhost:3001) before this request ever reaches us — so
      // request.headers.host alone would always resolve to the server's own
      // localhost, not the host the browser actually used (e.g. a Tailscale
      // hostname), and a client accessing over that path would be handed a
      // ws= URL pointing at its own localhost:3001, which fails to connect.
      // xfwd:true on the same proxy adds X-Forwarded-Host/-Proto, which we
      // prefer here; only fall back to the (possibly proxy-rewritten) Host
      // header for requests that didn't go through that proxy at all (e.g.
      // hitting the server directly, or a production reverse proxy that
      // doesn't set X-Forwarded-Host).
      const fwdHost = (request.headers['x-forwarded-host'] as string | undefined)?.split(',')[0]?.trim();
      const host = fwdHost || request.headers.host || 'localhost:3001';
      const fwdProto = (request.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim();
      const proto = fwdProto === 'https' ? 'wss' : 'ws';
      const wsPath = `${host}/ws?mode=devtools&server=${encodeURIComponent(serverName)}&target=${targetId}`;

      const rev = await getDevtoolsRev(srv ?? null);

      const inspectorUrl = `/devtools-fe/@${rev}/devtools_app.html?${proto}=${encodeURIComponent(wsPath)}`;
      return reply.send({ inspectorUrl });
    } catch (err: unknown) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  fastify.get('/devtools-fe/*', async (request, reply) => {
    const rawPath = (request.params as Record<string, string>)['*'];
    if (!rawPath) return reply.status(400).send({ error: 'path required' });

    const revMatch = rawPath.match(/^@([0-9a-f]+)\//i);
    if (!revMatch) return reply.status(400).send({ error: 'revision segment required (e.g. /devtools-fe/@<rev>/...)' });
    const rev = revMatch[1];
    const filePath = rawPath.slice(revMatch[0].length);
    if (!filePath) return reply.status(400).send({ error: 'file path required after revision' });

    try {
      const cdnUrl = `https://chrome-devtools-frontend.appspot.com/serve_rev/@${rev}/${filePath}`;
      const res = await fetch(cdnUrl, {
        headers: { 'accept-encoding': 'identity' },
      });

      if (!res.ok) return reply.status(res.status).send({ error: `CDN returned ${res.status}` });

      const contentType = res.headers.get('content-type') || 'application/octet-stream';

      if (contentType.includes('text/html') || contentType.includes('application/javascript') || contentType.includes('text/css')) {
        let text = await res.text();
        if (contentType.includes('text/html')) {
          text = text.replace(/<meta[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/gi, '');
        }
        reply.header('content-type', contentType);
        return reply.send(text);
      }

      const arrayBuf = await res.arrayBuffer();
      reply.header('content-type', contentType);
      return reply.send(Buffer.from(arrayBuf));
    } catch (err: unknown) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  done();
};

export default devtoolsRoutes;

// DevTools' initial burst of CDP commands (sent immediately on WS open, well
// before the upstream Chromium connection finishes connecting) can be large;
// size the buffer generously so none of it gets evicted before upstream is
// ready to receive it.
const DEVTOOLS_RELAY_MAX_BUFFERED = 1000;
const DEVTOOLS_RELAY_MAX_BYTES = 5 * 1024 * 1024;

export function handleDevtoolsRelay(ws: WebSocket, target: string): void {
  if (!/^[A-F0-9]{32}$/i.test(target)) {
    ws.send(JSON.stringify({ error: 'Invalid target ID' }));
    ws.close();
    return;
  }
  const cdpUrl = `ws://127.0.0.1:9222/devtools/page/${target}`;
  const cdpWs = new WsClient(cdpUrl);

  // The DevTools frontend fires a large burst of CDP commands immediately on
  // WS open, well before cdpWs (the upstream connection to Chromium) has
  // finished connecting. The old code only registered ws.on('message') inside
  // cdpWs.on('open'), so that entire early burst arrived with no listener
  // attached and was silently dropped — DevTools never got responses to its
  // init commands and showed "disconnected". Buffer from the start and flush
  // in arrival order once upstream is ready. No coalescing: CDP command
  // ids/responses must stay in order and none may be dropped, unlike e.g. the
  // browser WS handler's mouseMoved/resize coalescing.
  //
  // onOverflow: unlike an input-event stream, losing even one buffered CDP
  // command is unrecoverable — DevTools would wait forever on a response
  // that can now never arrive. So instead of the default drop-oldest
  // (silently keep going), an overflow here tears the whole connection down;
  // DevTools reconnects and retries its handshake from scratch.
  const messageRelay = createBufferedMessageRelay<Buffer | string>({
    maxBuffered: DEVTOOLS_RELAY_MAX_BUFFERED,
    maxBytes: DEVTOOLS_RELAY_MAX_BYTES,
    sizeOf: messageByteSize,
    onOverflow: () => {
      if (ws.readyState === ws.OPEN) ws.close(1011, 'relay buffer overflow');
      if (cdpWs.readyState === WsClient.OPEN) cdpWs.close();
    },
  });
  ws.on('message', (data: Buffer | string) => {
    messageRelay.push(data);
  });

  cdpWs.on('open', () => {
    messageRelay.deliverTo((data) => {
      if (cdpWs.readyState === WsClient.OPEN) {
        cdpWs.send(data.toString());
      }
    });
  });

  cdpWs.on('message', (data: Buffer | string) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(data.toString());
    }
  });

  cdpWs.on('close', () => {
    if (ws.readyState === ws.OPEN) ws.close();
  });

  cdpWs.on('error', () => {
    messageRelay.clear();
    if (ws.readyState === ws.OPEN) ws.close(1011, 'Upstream CDP connection failed');
  });

  ws.on('close', () => {
    messageRelay.clear();
    if (cdpWs.readyState === WsClient.OPEN) cdpWs.close();
  });
}
