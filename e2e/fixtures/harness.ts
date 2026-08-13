// E2E ハーネス: AZITO ハブを実ホストから完全に隔離した状態で1インスタンス起動し、
// テストが使う tmux / 偽エージェント / transcript フィクスチャの操作口をまとめて提供する。
//
// 隔離の担保:
//  - データ: `AZITO_DATA_DIR` を実行ごとの一時ディレクトリに向ける。DB・master.key・ui-token・
//    sidekicks がすべてそこに閉じる。空の data.db と master.key を先に置くことで、リポジトリ直下の
//    開発用 data.db を新ディレクトリへコピーする起動時データ移行（migrateDataIfNeeded）を確実に
//    抑止する（開発機の実データに一切触れない）。
//  - tmux: `TMUX_TMPDIR` を一時ディレクトリに向ける。tmux のソケットパスは
//    `$TMUX_TMPDIR/tmux-<uid>/default` なので、これだけでホストの tmux サーバー
//    （/tmp/tmux-<uid>/default）とは別サーバーになる。ハブ側の local トランスポートは
//    `tmux`（mux_runtime='system'）を素の PATH から execFile し、環境変数を丸ごと継承するため、
//    ハーネスとハブは同じ隔離ソケットを共有し、実ペインには一切触れない。
//    （ハブには `-L` を渡す口が無い＝ソケット名では隔離できないので、ソケット *ディレクトリ* で隔離する）
//  - ポート: 起動ごとに空きポートを取得して `PORT` に渡す。:3001 / :5173 は使わない。
//  - Claude transcript: `CLAUDE_CONFIG_DIR` を一時ディレクトリに向け、Tier 4 が読むセッション
//    JSONL をテストが書けるようにする（実ユーザーの ~/.claude は読まれない）。
//
// フロントエンドはリポジトリ直下 `public/` の vite ビルド成果物をハブ自身が @fastify/static で
// 配信する（`npm run e2e` が build:web を先に走らせる）。vite dev / preview は使わない。

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FAKE_AGENT_SRC = path.join(__dirname, 'fake-agent', 'claude');
const SUPERVISOR_DIST = path.join(REPO_ROOT, 'packages', 'tui-supervisor', 'dist', 'azito-supervisor.cjs');
const SERVER_ENTRY = path.join(REPO_ROOT, 'packages', 'server', 'src', 'main.ts');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

const SERVER_READY_TIMEOUT_MS = 60_000;
const SUPERVISOR_READY_TIMEOUT_MS = 30_000;

export type FakeAgentState = 'idle' | 'working' | 'exit';

export interface FakeAgent {
  /** tmux ターゲット（`session:windowName`）。windows API の tmux_target と同じ形。 */
  readonly target: string;
  /** 偽エージェントの状態を切り替える（--titles モードのみ意味を持つ）。 */
  setState(state: FakeAgentState): void;
  /** tmux ウィンドウごと破棄する。 */
  kill(): Promise<void>;
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      if (address === null || typeof address === 'string') {
        srv.close(() => reject(new Error('failed to allocate a free port')));
        return;
      }
      const { port } = address;
      srv.close(() => resolve(port));
    });
  });
}

function assertPrerequisites(): void {
  if (!fs.existsSync(path.join(REPO_ROOT, 'public', 'index.html'))) {
    throw new Error(
      `public/index.html not found. Run \`npm run build:web\` first (\`npm run e2e\` does this for you).`,
    );
  }
  if (!fs.existsSync(SUPERVISOR_DIST)) {
    throw new Error(
      `${SUPERVISOR_DIST} not found. Run \`npm run build --workspace=packages/tui-supervisor\` first ` +
      `(\`npm run e2e\` does this for you).`,
    );
  }
  if (!fs.existsSync(TSX_CLI)) {
    throw new Error(`${TSX_CLI} not found. Run \`npm install\` at the repository root.`);
  }
}

export class Harness {
  private constructor(
    readonly baseUrl: string,
    readonly uiToken: string,
    readonly rootDir: string,
    readonly dataDir: string,
    readonly claudeConfigDir: string,
    readonly tmuxTmpDir: string,
    readonly fakeAgentPath: string,
    private readonly serverProcess: ChildProcess,
    private readonly childEnv: NodeJS.ProcessEnv,
    private readonly logPath: string,
  ) {}

  /**
   * このテストで作った後始末対象（偽エージェント／登録ウィンドウ行）。ハーネス自体は
   * ワーカースコープで使い回されるため、テストが失敗して spec 側の破棄処理へ到達しなくても
   * 残骸が次のテストへ漏れないよう、生成物をここで追跡して {@link cleanupTestResources} で
   * まとめて破棄する。
   */
  private trackedAgents: FakeAgent[] = [];
  private trackedWindowIds: number[] = [];

  static async start(): Promise<Harness> {
    assertPrerequisites();

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-e2e-'));
    const dataDir = path.join(root, 'data');
    const claudeConfigDir = path.join(root, 'claude');
    const tmuxTmpDir = path.join(root, 'tmux');
    const binDir = path.join(root, 'bin');
    for (const dir of [dataDir, path.join(claudeConfigDir, 'projects'), tmuxTmpDir, binDir]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    // 起動時データ移行の抑止（上のコメント参照）: db と master.key の両方が既に在れば早期 return する。
    fs.writeFileSync(path.join(dataDir, 'data.db'), '');
    fs.writeFileSync(path.join(dataDir, 'master.key'), crypto.randomBytes(32).toString('hex'), { mode: 0o600 });

    // 偽エージェントは basename が `claude` である必要があるので、実行ごとの一時 bin へコピーする。
    const fakeAgentPath = path.join(binDir, 'claude');
    fs.copyFileSync(FAKE_AGENT_SRC, fakeAgentPath);
    fs.chmodSync(fakeAgentPath, 0o755);

    const port = await findFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const uiToken = crypto.randomBytes(32).toString('hex');
    const webhookToken = crypto.randomBytes(32).toString('hex');

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: String(port),
      AZITO_BIND: '127.0.0.1',
      AZITO_DATA_DIR: dataDir,
      AZITO_UI_TOKEN: uiToken,
      AZITO_WEBHOOK_TOKEN: webhookToken,
      AZITO_PUBLIC_URL: baseUrl,
      // tui-supervisor が `/ws/supervisor` へ接続するときに読む2つ（resolveHubEnv）。
      // tmux サーバーはこの環境を継承して起動するので、以降の new-window にも伝播する。
      AZITO_URL: baseUrl,
      AZITO_ALLOWED_ORIGINS: baseUrl,
      AZITO_E2E_FAST_INTERVALS: '1',
      CLAUDE_CONFIG_DIR: claudeConfigDir,
      TMUX_TMPDIR: tmuxTmpDir,
      NODE_ENV: 'test',
    };
    // 継承した TMUX を残すと、ハーネス自身が tmux 内から起動された場合に tmux CLI が
    // 「現在のセッション」を勝手に解決してしまう。
    delete childEnv.TMUX;

    const logPath = path.join(root, 'server.log');
    const logFd = fs.openSync(logPath, 'a');
    let serverProcess: ChildProcess;
    try {
      serverProcess = spawn(process.execPath, [TSX_CLI, SERVER_ENTRY], {
        cwd: REPO_ROOT,
        env: childEnv,
        stdio: ['ignore', logFd, logFd],
      });
    } finally {
      // spawn() は fd を複製して子へ渡すので、親側の記述子はここで閉じてよい
      // （閉じないとワーカーの寿命ぶんリークする）。
      fs.closeSync(logFd);
    }

    const harness = new Harness(
      baseUrl, uiToken, root, dataDir, claudeConfigDir, tmuxTmpDir, fakeAgentPath,
      serverProcess, childEnv, logPath,
    );
    try {
      await harness.waitUntilHealthy();
    } catch (err) {
      await harness.stop();
      throw err;
    }
    return harness;
  }

  private async waitUntilHealthy(): Promise<void> {
    const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.serverProcess.exitCode !== null) {
        throw new Error(`azito server exited early (code ${this.serverProcess.exitCode}):\n${this.readLog()}`);
      }
      try {
        const res = await fetch(`${this.baseUrl}/api/health`);
        if (res.ok) return;
      } catch {
        /* まだ listen していない */
      }
      await sleep(200);
    }
    throw new Error(`azito server did not become healthy within ${SERVER_READY_TIMEOUT_MS}ms:\n${this.readLog()}`);
  }

  readLog(): string {
    try {
      return fs.readFileSync(this.logPath, 'utf-8').slice(-4000);
    } catch {
      return '(no server log)';
    }
  }

  // ─── HTTP API ───

  async api<T = unknown>(pathname: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl}/api${pathname}`, {
      ...init,
      headers: {
        // ボディが無いリクエストに Content-Type: application/json を付けると Fastify が
        // FST_ERR_CTP_EMPTY_JSON_BODY で 400 にするため、ボディがあるときだけ付ける。
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        Authorization: `Bearer ${this.uiToken}`,
        ...(init.headers ?? {}),
      },
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`${init.method ?? 'GET'} /api${pathname} -> ${res.status}: ${text}`);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async createProject(name: string): Promise<number> {
    const { id } = await this.api<{ ok: boolean; id: number }>('/projects', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    return id;
  }

  /**
   * 稼働検知の対象になる agent ウィンドウを1つ登録する。`agentSessionId` を渡すと Tier 4 が
   * 読む transcript セッションを明示的に紐付ける（PUT /api/windows/:id）。
   */
  async registerAgentWindow(
    projectId: number,
    target: string,
    options: { label?: string; agentSessionId?: string } = {},
  ): Promise<number> {
    const { id } = await this.api<{ ok: boolean; id: number }>(`/projects/${projectId}/windows`, {
      method: 'POST',
      body: JSON.stringify({
        server_name: 'local',
        tmux_target: target,
        label: options.label ?? target,
        window_type: 'agent',
        worker_type: 'claude',
      }),
    });
    this.trackedWindowIds.push(id);
    if (options.agentSessionId) {
      await this.api(`/windows/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ agent_session_id: options.agentSessionId }),
      });
    }
    return id;
  }

  async deleteWindow(windowId: number): Promise<void> {
    await this.api(`/windows/${windowId}`, { method: 'DELETE' });
    this.trackedWindowIds = this.trackedWindowIds.filter((id) => id !== windowId);
  }

  /**
   * 1テスト分の生成物を破棄する（test.ts の auto fixture が各テスト後に必ず呼ぶ）。
   * 破棄自体の失敗は握りつぶす — ここで投げると、本来の失敗原因を後始末のエラーが覆い隠す。
   */
  async cleanupTestResources(): Promise<void> {
    const agents = this.trackedAgents;
    const windowIds = this.trackedWindowIds;
    this.trackedAgents = [];
    this.trackedWindowIds = [];
    for (const agent of agents) {
      await agent.kill().catch(() => undefined);
    }
    for (const id of windowIds) {
      await this.api(`/windows/${id}`, { method: 'DELETE' }).catch(() => undefined);
    }
  }

  // ─── 隔離 tmux ───

  async tmux(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync('tmux', args, { env: this.childEnv });
  }

  /**
   * 偽エージェントを新しい tmux ウィンドウで起動する。
   *
   * - `supervised: true`  … tui-supervisor の dist バンドルで包んで起動する（Tier 0 経路）。
   *   supervisor はハブの `/ws/supervisor` へ AZITO_URL / AZITO_WEBHOOK_TOKEN で接続する。
   * - `supervised: false` … 偽エージェントを直接起動し、タイトルも出力も出さない（`--silent`）。
   *   Tier 2 のペイン分類が 'unknown' に落ちるので、Tier 4 が唯一の判定源になる。
   */
  async startFakeAgent(
    sessionName: string,
    windowName: string,
    options: { supervised: boolean },
  ): Promise<FakeAgent> {
    const target = `${sessionName}:${windowName}`;
    const stateFile = path.join(this.dataDir, `fake-agent-${sessionName}-${windowName}.state`);
    fs.writeFileSync(stateFile, 'idle');

    const agentCmd = `${shellQuote(process.execPath)} ${shellQuote(this.fakeAgentPath)} ` +
      `${options.supervised ? '--titles' : '--silent'} ${shellQuote(stateFile)}`;
    const command = options.supervised
      ? `${shellQuote(process.execPath)} ${shellQuote(SUPERVISOR_DIST)} ` +
        `--server local --target ${shellQuote(target)} -- ${shellQuote(agentCmd)}`
      : agentCmd;

    await this.ensureSession(sessionName);
    await this.tmux(['new-window', '-d', '-t', `${sessionName}:`, '-n', windowName, command]);
    // supervisor が WS 登録を終える前に状態を切り替えると、その遷移はハブに届かず、次の
    // 定期再送（ACTIVE_RESEND_MS = 15秒）まで稼働が見えない。登録完了まで待って競合を消す。
    if (options.supervised) await this.waitForSupervisor(target);

    const agent: FakeAgent = {
      target,
      setState: (state) => fs.writeFileSync(stateFile, state),
      kill: async () => {
        fs.writeFileSync(stateFile, 'exit');
        await this.tmux(['kill-window', '-t', target]).catch(() => undefined);
      },
    };
    this.trackedAgents.push(agent);
    return agent;
  }

  /** `GET /api/supervisors` に該当ターゲットの接続が現れるまで待つ。 */
  private async waitForSupervisor(target: string): Promise<void> {
    const deadline = Date.now() + SUPERVISOR_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const supervisors = await this.api<Array<{ target: string }>>('/supervisors');
      if (supervisors.some((s) => s.target === target)) return;
      await sleep(200);
    }
    throw new Error(`tui-supervisor for ${target} did not register within ${SUPERVISOR_READY_TIMEOUT_MS}ms`);
  }

  private async ensureSession(sessionName: string): Promise<void> {
    try {
      await this.tmux(['has-session', '-t', `=${sessionName}`]);
    } catch {
      await this.tmux(['new-session', '-d', '-s', sessionName, '-n', 'shell']);
    }
  }

  // ─── 後片付け ───

  async stop(): Promise<void> {
    try {
      await this.tmux(['kill-server']);
    } catch {
      /* tmux サーバーが立っていない場合は何もしなくてよい */
    }
    if (this.serverProcess.exitCode === null) {
      this.serverProcess.kill('SIGTERM');
      const deadline = Date.now() + 10_000;
      while (this.serverProcess.exitCode === null && Date.now() < deadline) await sleep(100);
      if (this.serverProcess.exitCode === null) this.serverProcess.kill('SIGKILL');
    }
    fs.rmSync(this.rootDir, { recursive: true, force: true });
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** POSIX シェル向けの単一引数クォート（tmux new-window / supervisor の `--` 以降で使う）。 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
