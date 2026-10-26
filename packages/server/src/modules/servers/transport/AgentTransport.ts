import { AGENT_HOST_RESOURCES_PATH, AgentResourcesOutdatedError, parseHostResourceSample, type HostResourceSample } from '../../../shared/os/hostResources';
import { EventEmitter } from 'events';
import WebSocket, { createWebSocketStream } from 'ws';
import type { Duplex } from 'stream';
import type {
  ExecResult,
  IServerTransport,
  IMuxTransport,
  IHostBoundTransport,
  ITerminalStream,
} from './ServerTransport';
import type { IPaneStream } from '../../tmux/PaneStream';
import { AgentPaneStream } from './AgentPaneStream';
import { AGENT_PANE_STREAMS_PATH, AgentOutdatedError } from './agentPaneStreamProtocol';
import { AgentUnreachableError, type AgentUnreachableReason } from './AgentUnreachableError';
import type { MuxRuntime } from '../Server';
import { AGENT_HOST_PATH, AgentHostOutdatedError, parseAgentHostInfo, type AgentHostInfo } from './agentHostProtocol';
import { assertPosixHost, toHostProfile, type HostProfile } from '../../../shared/os/hostProfile';
import { TaskTempFiles, assertTmpDirShellSafe, LEGACY_UNIX_TMP_DIR, type AgentTempHost, type TaskTempServer } from '../../../shared/os/taskTempFiles';
import { CommandOutputLimitError, CommandSpawnError, type CommandResult, type CommandSpec } from '../../../shared/exec/commandSpec';
import { truncateUtf8 } from '../../../shared/exec/utf8';
import { toPosixCommandLine } from '../../../shared/exec/posixCommandLine';
import { AGENT_RUN_PATH, responseToResult } from '../../../shared/exec/runWire';
import { AGENT_FILE_OPS_PATH, RemoteFileOps, type FileOpRequest } from '../../../shared/fs/fileOpsWire';
import type { IFileOps } from '../../../shared/fs/fileOps';
import { AGENT_PROCESSES_PATH, listProcessesWith, parseProcessList, type ListProcessesOptions, type ProcessEntry } from '../../../shared/os/processList';
import { ShellFileOps } from './ShellFileOps';
import { AgentFileOpOutdatedError, rejectsOperationName } from './agentFileOpsProtocol';
import type { MisaoReleaseFile, MisaoSocketStatus } from './agentMisaoSocket';
import { type MuxRef, type PaneHandle, type PaneOrdinal, type MuxExecRequest, formatMuxRef, tmuxTargetFromMuxRef } from '@azito/shared';

const PING_INTERVAL_MS = 15_000;
/** How long an agent judged unreachable fails fast before a background /health probe may revive it. */
const CIRCUIT_OPEN_MS = 15_000;
export const HEALTH_TIMEOUT_MS = 3_000;
/** Matches the agent's own default exec timeout (agent/routes.ts); the HTTP deadline is this plus transit slack. */
const DEFAULT_EXEC_TIMEOUT_MS = 15_000;
const HTTP_SLACK_MS = 5_000;
/** A conversation-log read (listing or one range of a JSONL) over a tailnet link. */
const TRANSCRIPT_TIMEOUT_MS = 10_000;
/** One release file over a tailnet link: seconds in practice, with room for a slow one. */
const MISAO_UPLOAD_TIMEOUT_MS = 120_000;
/** One file operation (a read or write of up to the size limit) over a tailnet link. */
const FILE_OPS_TIMEOUT_MS = 60_000;
/** A Windows host's CIM query can take several seconds. */
const PROCESS_LIST_TIMEOUT_MS = 30_000;

function classifyFetchError(err: unknown): AgentUnreachableReason | null {
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return 'timeout';
  if (!(err instanceof TypeError)) return null;
  const code = (err.cause as { code?: string } | undefined)?.code;
  if (code === 'ECONNREFUSED') return 'refused';
  if (code === 'UND_ERR_CONNECT_TIMEOUT') return 'timeout';
  return 'unreachable';
}

class AgentTerminalStream extends EventEmitter implements ITerminalStream {
  closeCode?: number;
  closeReason?: string;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private missedPongs = 0;

  constructor(private ws: WebSocket) {
    super();
    ws.on('message', (data: Buffer | string) => {
      this.emit('data', data.toString());
    });
    ws.on('close', (code: number, reason: Buffer) => {
      this.stopHeartbeat();
      this.closeCode = code;
      this.closeReason = reason.toString();
      this.emit('close');
    });
    ws.on('error', (err) => this.emit('error', err));
    ws.on('pong', () => { this.missedPongs = 0; });
    this.startHeartbeat();
  }

  write(data: string): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(data);
  }

  resize(cols: number, rows: number): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  }

  close(): void {
    this.stopHeartbeat();
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close();
    }
  }

  private startHeartbeat(): void {
    this.pingTimer = setInterval(() => {
      if (this.missedPongs >= 2) { this.ws.terminate(); return; }
      this.missedPongs++;
      this.ws.ping();
    }, PING_INTERVAL_MS);
    this.pingTimer.unref();
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = undefined; }
  }
}

const HOST_RESOURCES_TIMEOUT_MS = 8_000;

export class AgentTransport implements IServerTransport, IMuxTransport, IHostBoundTransport {
  private baseUrl: string;
  private wsBaseUrl: string;
  private authHeader: string;
  private useLegacyMuxRoute = false;
  private fileOps: IFileOps | null = null;
  /** Where this agent's task files go: learned from the agent (`loadTaskTempHost`), kept for the life of this transport (it is rebuilt when the server is edited). */
  private taskTempHost: AgentTempHost | null = null;
  private taskTempHostLoad: Promise<AgentTempHost> | null = null;
  /** Set when the agent answered `404` to `GET /api/processes`: it is older than the endpoint. */
  private lacksProcessesEndpoint = false;

  private token: string;

  private muxRuntime: MuxRuntime;

  // Circuit breaker: epoch ms until which calls fail fast; 0 = closed.
  private unreachableUntil = 0;
  private probe: Promise<unknown> | null = null;
  // Request sequencing (see send()): the last handed-out sequence and the newest sequence whose outcome was applied.
  private nextSeq = 0;
  private appliedSeq = 0;

  /** `hostProfile`: the agent's OS / architecture as recorded; null for an agent registered before it was (treated as a Unix one). */
  constructor(host: string, port: number, token: string, muxRuntime: MuxRuntime, private serverName: string, readonly hostProfile: HostProfile | null) {
    this.token = token;
    this.muxRuntime = muxRuntime;
    this.baseUrl = `http://${host}:${port}`;
    this.wsBaseUrl = `ws://${host}:${port}`;
    this.authHeader = `Bearer ${token}`;
  }

  matchesToken(token: string): boolean {
    return this.token === token;
  }

  matchesMuxRuntime(runtime: MuxRuntime): boolean {
    return this.muxRuntime === runtime;
  }

  matchesHostProfile(profile: HostProfile | null): boolean {
    return this.hostProfile?.platform === profile?.platform && this.hostProfile?.arch === profile?.arch;
  }

  /**
   * Runs `spec` on the agent's host. The route is chosen here, once, from what is recorded of the host: an agent whose
   * host is recorded has `POST /api/run` (it ships with `GET /api/host`, which is what recorded it); an unrecorded one
   * predates both, so the spec is turned into a quoted POSIX command line for its `POST /api/exec`. A failed `/api/run`
   * is never retried through the shell.
   */
  async run(spec: CommandSpec): Promise<CommandResult> {
    if (this.hostProfile === null) return this.runThroughShell(spec);
    this.assertCircuitClosed();
    const { status, text } = await this.send(AGENT_RUN_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: this.authHeader },
      body: JSON.stringify(spec),
    }, spec.timeoutMs + HTTP_SLACK_MS);
    if (status < 200 || status >= 300) throw new Error(`Agent ${AGENT_RUN_PATH} failed (${status}): ${text}`);
    return responseToResult(JSON.parse(text));
  }

  /**
   * The agent's file operations. The route is chosen here, once, from what is recorded of the host, like `run`: an agent
   * whose host is recorded has `POST /api/fileops` (it ships with `GET /api/host`, which is what recorded it); an unrecorded
   * one predates both, so its files are reached with shell commands (`ShellFileOps`). A failing route is never retried
   * through the other.
   */
  files(): IFileOps {
    if (this.hostProfile === null) return (this.fileOps ??= new ShellFileOps(this));
    const platform = this.hostProfile.platform;
    return (this.fileOps ??= new RemoteFileOps(platform, (request) => this.sendFileOp(request)));
  }

  /**
   * The agent's processes (`GET /api/processes`). An agent without the endpoint (`404`, or one registered before its host was
   * recorded, which predates it too) is older than this hub: its list is taken by running the same command through `run` instead
   * (the shell route for an unrecorded host, which is a Unix one). A failing endpoint is never retried through `run`.
   */
  async listProcesses(options: ListProcessesOptions = {}): Promise<ProcessEntry[]> {
    const run = (spec: CommandSpec): Promise<CommandResult> => this.run(spec);
    if (this.hostProfile === null) return listProcessesWith('linux', run, options);
    if (this.lacksProcessesEndpoint) return listProcessesWith(this.hostProfile.platform, run, options);
    this.assertCircuitClosed();
    const { status, text } = await this.send(AGENT_PROCESSES_PATH, { method: 'GET', headers: { authorization: this.authHeader } }, options.timeoutMs ?? PROCESS_LIST_TIMEOUT_MS);
    if (status === 404) {
      // Remembered: this transport is rebuilt when the agent is redeployed, so the mark cannot outlive the old agent.
      this.lacksProcessesEndpoint = true;
      return listProcessesWith(this.hostProfile.platform, run, options);
    }
    if (status < 200 || status >= 300) throw new Error(`Agent ${AGENT_PROCESSES_PATH} failed (${status}): ${text}`);
    return parseProcessList(JSON.parse(text));
  }

  /**
   * Memory and disk of the agent's host (`GET /api/host/resources`). An agent without the endpoint (`404`) is older than this hub
   * and rejects with `AgentResourcesOutdatedError`; there is nothing to fall back to, since its host has no sh to measure with.
   */
  async measureHostResources(): Promise<HostResourceSample> {
    this.assertCircuitClosed();
    const { status, text } = await this.send(AGENT_HOST_RESOURCES_PATH, { method: 'GET', headers: { authorization: this.authHeader } }, HOST_RESOURCES_TIMEOUT_MS);
    if (status === 404) throw new AgentResourcesOutdatedError(this.serverName);
    if (status < 200 || status >= 300) throw new Error(`Agent ${AGENT_HOST_RESOURCES_PATH} failed (${status}): ${text}`);
    return parseHostResourceSample(JSON.parse(text));
  }

  /** Performs one file operation on the agent's host (`POST /api/fileops`) and returns the response body, which says how it ended (see `RemoteFileOps`). */
  private async sendFileOp(request: FileOpRequest): Promise<unknown> {
    this.assertCircuitClosed();
    const { status, text } = await this.send(AGENT_FILE_OPS_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: this.authHeader },
      body: JSON.stringify(request),
    }, FILE_OPS_TIMEOUT_MS);
    // An agent that has /api/fileops but not this operation rejects the request because its schema has no such `op`; any other 400 is a request it understood and refused.
    if (status === 400 && request.op === 'searchContent' && rejectsOperationName(text)) throw new AgentFileOpOutdatedError(this.serverName, request.op);
    if (status < 200 || status >= 300) throw new Error(`Agent ${AGENT_FILE_OPS_PATH} failed (${status}): ${text}`);
    return JSON.parse(text);
  }

  /** The run of an agent without `/api/run`: the quoted command line through `exec`. See `toPosixCommandLine` for what a shell cannot report. */
  private async runThroughShell(spec: CommandSpec): Promise<CommandResult> {
    const result = await this.exec(toPosixCommandLine(spec), spec.timeoutMs);
    // The limit is in bytes, like the shared runner's, and a character is never cut in half.
    if (Buffer.byteLength(result.stdout) > spec.maxOutputBytes || Buffer.byteLength(result.stderr) > spec.maxOutputBytes) {
      throw new CommandOutputLimitError(spec.maxOutputBytes, truncateUtf8(result.stdout, spec.maxOutputBytes), truncateUtf8(result.stderr, spec.maxOutputBytes));
    }
    // sh: 127 = command not found. The program's own 127 is told apart by sh having named it on stderr.
    if (result.code === 127 && /not found/i.test(result.stderr)) {
      throw new CommandSpawnError('ENOENT', `spawn ${spec.file} ENOENT`, result.stdout, result.stderr);
    }
    return { exitCode: result.code, signal: null, stdout: result.stdout, stderr: result.stderr };
  }

  /** @deprecated POSIX-only: the agent runs `command` with `/bin/sh -c`. Rejects when the agent's host is win32. */
  async exec(command: string, timeoutMs?: number): Promise<ExecResult> {
    assertPosixHost(this.hostProfile, `agent server "${this.serverName}"`);
    return this.post('/api/exec', { command, ...(timeoutMs !== undefined ? { timeoutMs } : {}) }, timeoutMs);
  }

  async execMux(req: MuxExecRequest): Promise<ExecResult> {
    if (!this.useLegacyMuxRoute) {
      try {
        const body = req.kind === 'tmux'
          ? { ...req, mux: this.muxRuntime }
          : req;
        return await this.post('/api/mux', body as Record<string, unknown>);
      } catch (err) {
        if (req.kind === 'tmux' && (err as Error).message.includes('failed (404)')) {
          this.useLegacyMuxRoute = true;
          return this.post('/api/tmux', { args: req.args, mux: this.muxRuntime });
        }
        throw err;
      }
    }
    if (req.kind !== 'tmux') throw new Error(`Legacy agent does not support mux kind "${req.kind}"`);
    return this.post('/api/tmux', { args: req.args, mux: this.muxRuntime });
  }

  openTerminal(ref: MuxRef, ordinal: PaneOrdinal, cols: number, rows: number, opts?: import('./ServerTransport').OpenTerminalOpts): Promise<ITerminalStream> {
    const target = tmuxTargetFromMuxRef(ref);
    const refParam = `&ref=${encodeURIComponent(formatMuxRef(ref))}&pane=${ordinal}`;
    return new Promise((resolve, reject) => {
      const url = `${this.wsBaseUrl}/ws?mode=terminal&target=${encodeURIComponent(target)}${refParam}&cols=${cols}&rows=${rows}&mux=${this.muxRuntime}`;
      const ws = new WebSocket(url, { headers: { authorization: this.authHeader } });

      const onError = (err: Error) => { clearTimeout(timer); reject(err); };
      const onOpen = () => {
        clearTimeout(timer);
        ws.removeListener('error', onError);
        resolve(new AgentTerminalStream(ws));
      };
      const timer = setTimeout(() => {
        // Issue #239: do NOT removeAllListeners() here. terminate() on a socket
        // that is still CONNECTING makes `ws` emit 'error' ("WebSocket was
        // closed before the connection was established"); with no listener
        // attached that becomes an unhandled 'error' event and kills the hub.
        ws.removeListener('open', onOpen);
        ws.removeListener('error', onError);
        ws.on('error', () => { /* swallow the terminate()-induced error */ });
        ws.terminate();
        reject(new Error('openTerminal timed out'));
      }, 15_000);
      ws.on('error', onError);
      ws.on('open', onOpen);
    });
  }

  /**
   * Where this agent keeps the files of a task (its OS and temp folder): asked of the agent once (`GET /api/host`) and
   * remembered. An agent whose host was never recorded predates that endpoint and is a Unix one with `/tmp`. Rejects when the
   * agent cannot be reached or reports a temp folder that is unsafe in a Unix shell command; nothing is remembered then.
   */
  loadTaskTempHost(): Promise<AgentTempHost> {
    if (this.taskTempHost) return Promise.resolve(this.taskTempHost);
    this.taskTempHostLoad ??= this.fetchTaskTempHost()
      .then((host) => { this.taskTempHost = host; return host; })
      .finally(() => { this.taskTempHostLoad = null; });
    return this.taskTempHostLoad;
  }

  /**
   * The agent's own node executable, for a worker that is told to run a Node script (`azitoctl.mjs`) on a Windows host where `node` may not be on
   * its PATH. An agent from before it was reported cannot say: that is an error (update the agent), not a guess.
   */
  async fetchNodeExecPath(): Promise<string> {
    const info = await this.fetchHostInfo();
    if (info.execPath === undefined) {
      throw new Error(`Agent server "${this.serverName}" did not report its node executable (GET /api/host execPath); update the agent`);
    }
    return info.execPath;
  }

  private async fetchTaskTempHost(): Promise<AgentTempHost> {
    if (this.hostProfile === null) return { platform: 'linux', tmpDir: LEGACY_UNIX_TMP_DIR };
    const info = await this.fetchHostInfo();
    const platform = toHostProfile(info.platform, info.arch).platform;
    // An agent from before the temp folder was reported is a Unix one with /tmp. Windows agents are new in this release, so one that
    // does not report it is not a state to paper over.
    if (info.tmpDir === undefined && platform === 'win32') {
      throw new Error(`Windows agent server "${this.serverName}" did not report its temp folder (GET /api/host tmpDir); update the agent`);
    }
    const host: AgentTempHost = { platform, tmpDir: info.tmpDir ?? LEGACY_UNIX_TMP_DIR };
    assertTmpDirShellSafe(host.platform, host.tmpDir, `agent server "${this.serverName}"`);
    return host;
  }

  createPaneStream(handle: PaneHandle, tempServer: TaskTempServer): IPaneStream {
    if (tempServer.type !== 'agent') throw new Error(`Agent server "${this.serverName}" needs the agent's temp folder to name a pane stream file`);
    const filePath = TaskTempFiles.remotePipeFile(tempServer, handle as string, Date.now());
    return new AgentPaneStream(filePath, this, this.wsBaseUrl, this.authHeader);
  }

  /**
   * Has the agent create and manage a pane-stream file (`POST /api/pane-streams`); `/ws?mode=file-tail` serves only managed
   * files. Safe to repeat (the file is not truncated), which is how a reconnect re-registers after an agent restart.
   * Rejects with AgentOutdatedError when the agent does not have the endpoint (an older agent: `404`), and with a plain
   * Error when the agent refuses the path or cannot be reached.
   */
  async registerPaneStreamFile(filePath: string): Promise<void> {
    this.assertCircuitClosed();
    const { status, text } = await this.send(AGENT_PANE_STREAMS_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: this.authHeader },
      body: JSON.stringify({ path: filePath }),
    }, DEFAULT_EXEC_TIMEOUT_MS + HTTP_SLACK_MS);
    if (status === 404) throw new AgentOutdatedError(this.serverName);
    if (status < 200 || status >= 300) throw new Error(`Agent ${AGENT_PANE_STREAMS_PATH} failed (${status}): ${text}`);
  }

  /** Releases a registered pane-stream file and removes it on the agent. Unknown paths are ignored by the agent. */
  async releasePaneStreamFile(filePath: string): Promise<void> {
    this.assertCircuitClosed();
    const { status, text } = await this.send(
      `${AGENT_PANE_STREAMS_PATH}?path=${encodeURIComponent(filePath)}`,
      { method: 'DELETE', headers: { authorization: this.authHeader } },
      DEFAULT_EXEC_TIMEOUT_MS + HTTP_SLACK_MS,
    );
    if (status < 200 || status >= 300) throw new Error(`Agent ${AGENT_PANE_STREAMS_PATH} failed (${status}): ${text}`);
  }

  /**
   * Opens the agent's misao relay (`/ws?mode=misao`): a byte pipe to the agent's own misao socket, as a Duplex the SDK
   * can speak its protocol over (`MisaoClient({ connect })`). The agent chooses the socket, never this side. Rejects when
   * the WebSocket cannot be opened; a relay that is up but has no daemon behind it closes right after opening, which the
   * SDK sees as a lost connection.
   */
  connectMisaoRelay(signal: AbortSignal): Promise<Duplex> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('aborted'));
        return;
      }
      const ws = new WebSocket(`${this.wsBaseUrl}/ws?mode=misao`, { headers: { authorization: this.authHeader } });
      const abandon = (): void => {
        ws.removeListener('open', onOpen);
        ws.on('error', () => { /* the terminate()-induced error: nobody is left to hear it */ });
        ws.terminate();
        reject(new Error('aborted'));
      };
      const onError = (err: Error): void => {
        signal.removeEventListener('abort', abandon);
        reject(err);
      };
      const onOpen = (): void => {
        signal.removeEventListener('abort', abandon);
        ws.removeListener('error', onError);
        resolve(createWebSocketStream(ws));
      };
      signal.addEventListener('abort', abandon, { once: true });
      ws.once('error', onError);
      ws.once('open', onOpen);
    });
  }

  /** What is on the agent's disk for misao (`GET /api/misao/status`). Shares the breaker like every agent call. */
  async fetchMisaoStatus(): Promise<MisaoSocketStatus> {
    this.assertCircuitClosed();
    const { status, text } = await this.send('/api/misao/status', { method: 'GET', headers: { authorization: this.authHeader } }, HEALTH_TIMEOUT_MS);
    if (status < 200 || status >= 300) throw new Error(`Agent /api/misao/status failed (${status}): ${text}`);
    return JSON.parse(text) as MisaoSocketStatus;
  }

  /**
   * What the agent says about its own host (`GET /api/host`): OS, architecture and default shell. Shares the breaker like
   * every agent call. Rejects with AgentHostOutdatedError when the agent has no such endpoint (an older agent: `404`).
   */
  async fetchHostInfo(): Promise<AgentHostInfo> {
    this.assertCircuitClosed();
    const { status, text } = await this.send(AGENT_HOST_PATH, { method: 'GET', headers: { authorization: this.authHeader } }, HEALTH_TIMEOUT_MS);
    if (status === 404) throw new AgentHostOutdatedError(this.serverName);
    if (status < 200 || status >= 300) throw new Error(`Agent ${AGENT_HOST_PATH} failed (${status}): ${text}`);
    return parseAgentHostInfo(JSON.parse(text));
  }

  /**
   * Puts one release file of misao where the agent stages it (`PUT /api/misao/upload`): `<home>/.azito/misao/<version>.upload/`.
   * The agent decides the location; this side only names the version and which release file it is. Returns what the
   * agent received (size, sha256) so the caller can compare it with the hash it expects.
   */
  async uploadMisaoFile(version: string, name: MisaoReleaseFile, data: Buffer): Promise<{ name: string; size: number; sha256: string }> {
    this.assertCircuitClosed();
    const query = `version=${encodeURIComponent(version)}&name=${encodeURIComponent(name)}`;
    const { status, text } = await this.send(`/api/misao/upload?${query}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream', authorization: this.authHeader },
      body: new Blob([Uint8Array.from(data)]),
    }, MISAO_UPLOAD_TIMEOUT_MS);
    if (status < 200 || status >= 300) throw new Error(`Agent /api/misao/upload failed (${status}): ${text}`);
    return JSON.parse(text) as { name: string; size: number; sha256: string };
  }

  /**
   * GET a JSON endpoint of the agent (e.g. the conversation-log API). Shares the breaker like every agent call: while
   * it is open this throws `AgentUnreachableError` without fetching. The status and parsed body are returned as they
   * are, so the caller decides what a 404 means; a body that is not JSON comes back as `null`.
   */
  async getJson(path: string, timeoutMs: number = TRANSCRIPT_TIMEOUT_MS): Promise<{ status: number; body: unknown }> {
    this.assertCircuitClosed();
    const { status, text } = await this.send(path, { method: 'GET', headers: { authorization: this.authHeader } }, timeoutMs);
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { status, body };
  }

  /** True while the breaker is open (fail-fast window), so callers can skip the network entirely. */
  isCircuitOpen(): boolean {
    return Date.now() < this.unreachableUntil;
  }

  /**
   * GET /health with a short deadline, sharing the breaker. Open: throws `circuit_open` without fetching.
   * Half-open: starts (or joins) the single shared probe and returns its outcome, so a recovered agent is reported
   * online right away. Non-2xx responses mean the agent is reachable but unhealthy and throw a plain Error.
   */
  async fetchHealth(): Promise<unknown> {
    if (this.isCircuitOpen()) throw new AgentUnreachableError(this.serverName, 'circuit_open');
    if (this.unreachableUntil !== 0) return this.ensureProbe();
    return this.requestHealth();
  }

  private async requestHealth(): Promise<unknown> {
    const { status, text } = await this.send('/health', { method: 'GET' }, HEALTH_TIMEOUT_MS);
    if (status < 200 || status >= 300) throw new Error(`Agent /health failed (${status})`);
    return JSON.parse(text) as unknown;
  }

  /**
   * One HTTP round trip including the body read, so a drop or deadline during body transfer is classified like any
   * other network failure. Each round trip takes a monotonically increasing sequence at start; its outcome (success
   * or failure, whatever the breaker state) updates the breaker only if it is newer than the last applied outcome,
   * so a late result of an older request never overrides a newer one.
   */
  private async send(path: string, init: RequestInit, deadlineMs: number): Promise<{ status: number; text: string }> {
    const seq = ++this.nextSeq;
    try {
      const res = await fetch(`${this.baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(deadlineMs) });
      const text = await res.text();
      if (seq > this.appliedSeq) {
        this.appliedSeq = seq;
        this.unreachableUntil = 0;
      }
      return { status: res.status, text };
    } catch (err) {
      const reason = classifyFetchError(err);
      if (!reason) throw err;
      if (seq > this.appliedSeq) {
        this.appliedSeq = seq;
        this.unreachableUntil = Date.now() + CIRCUIT_OPEN_MS;
      }
      throw new AgentUnreachableError(this.serverName, reason);
    }
  }

  /** The single shared half-open /health probe (started on demand, joined by concurrent callers). */
  private ensureProbe(): Promise<unknown> {
    if (!this.probe) {
      this.probe = this.requestHealth().finally(() => { this.probe = null; });
    }
    return this.probe;
  }

  /** Fails fast while the breaker is open; once it expires, the shared probe runs in the background and calls keep failing fast until it closes the breaker. */
  private assertCircuitClosed(): void {
    if (this.unreachableUntil === 0) return;
    if (!this.isCircuitOpen()) this.ensureProbe().catch(() => undefined);
    throw new AgentUnreachableError(this.serverName, 'circuit_open');
  }

  private async post(path: string, body: Record<string, unknown>, timeoutMs?: number): Promise<ExecResult> {
    this.assertCircuitClosed();
    const { status, text } = await this.send(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: this.authHeader,
      },
      body: JSON.stringify(body),
    }, (timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS) + HTTP_SLACK_MS);
    if (status < 200 || status >= 300) throw new Error(`Agent ${path} failed (${status}): ${text}`);
    return JSON.parse(text) as ExecResult;
  }
}
