// E2E 用の misao デーモン: 実行ごとの一時ディレクトリで自前のデーモンを起動する。
//
// 隔離の担保:
//  - ソケットとデータ（`--socket` / `--data`）を一時ディレクトリに向ける。server001 に常駐している
//    デーモン（~/.misao/misao.sock）には接続も操作もしない。CLI を呼ぶときも MISAO_DIR /
//    MISAO_CONFIG を落とし、MISAO_SOCKET を一時ソケットへ固定する。
//  - 停止は起動時に記録した PID にだけシグナルを送る（pkill / killall は使わない）。
//  - ソケットパスは UNIX ドメインソケットの上限（107 バイト）以内であることを起動前に確認する。
//
// misao CLI のビルド成果物（MISAO_CLI、既定 ~/workspace/misao/packages/cli/dist/main.js）が無い環境では
// {@link MisaoDaemon.cliPath} が null を返し、spec 側が理由付きで skip する。

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SOCKET_BYTES_MAX = 107;
const DAEMON_READY_TIMEOUT_MS = 15_000;
const DAEMON_STOP_TIMEOUT_MS = 5_000;

/** `misao new --json` が返すペイン情報のうち、ハブへ登録するのに要る部分。 */
export interface MisaoWindow {
  /** `formatMuxRef` 形式の JSON 文字列（POST /api/projects/:id/windows の `ref`）。 */
  ref: string;
  workspace: string;
  windowId: string;
  windowName: string;
  paneId: string;
}

interface NewPaneJson {
  paneId: string;
  workspace: string;
  window: { id: string; name: string };
}

export class MisaoDaemon {
  private constructor(
    readonly socketPath: string,
    readonly dir: string,
    readonly pid: number,
    private readonly process: ChildProcess,
    private readonly cli: string,
  ) {}

  /** misao CLI のパス。ビルド成果物が無ければ null（spec はこの場合 skip する）。 */
  static cliPath(): string | null {
    const cli = process.env.MISAO_CLI ?? path.join(os.homedir(), 'workspace/misao/packages/cli/dist/main.js');
    return fs.existsSync(cli) ? cli : null;
  }

  static async start(): Promise<MisaoDaemon> {
    const cli = MisaoDaemon.cliPath();
    if (cli === null) throw new Error('misao CLI not found (set MISAO_CLI to packages/cli/dist/main.js of a misao checkout)');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azm-'));
    const socketPath = path.join(dir, 'm.sock');
    if (Buffer.byteLength(socketPath) > SOCKET_BYTES_MAX) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new Error(`misao socket path exceeds ${SOCKET_BYTES_MAX} bytes: ${socketPath}`);
    }
    const child = spawn(process.execPath, [cli, 'serve', '--socket', socketPath, '--data', dir], {
      env: isolatedEnv(socketPath),
      stdio: 'ignore',
    });
    if (child.pid === undefined) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new Error('failed to spawn the misao daemon');
    }
    const daemon = new MisaoDaemon(socketPath, dir, child.pid, child, cli);
    try {
      await daemon.waitUntilReady();
    } catch (err) {
      await daemon.stop();
      throw err;
    }
    return daemon;
  }

  private async waitUntilReady(): Promise<void> {
    const deadline = Date.now() + DAEMON_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.process.exitCode !== null) throw new Error(`misao daemon exited early (code ${this.process.exitCode})`);
      if (fs.existsSync(this.socketPath)) {
        try {
          await this.run(['status']);
          return;
        } catch {
          /* ソケットはあるがまだ受け付けていない */
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`misao daemon did not become ready within ${DAEMON_READY_TIMEOUT_MS}ms`);
  }

  private async run(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync(process.execPath, [this.cli, ...args], { env: isolatedEnv(this.socketPath) });
    return stdout;
  }

  /**
   * ウィンドウをコマンド付きで開く（`misao new --workspace W --window N -- cmd`）。ハブ側で窓を
   * 作るのではなく、デーモンに直接作らせた窓をハブへ登録する経路の入口（稼働検知の検証用）。
   */
  async openWindow(workspace: string, windowName: string, command: string[]): Promise<MisaoWindow> {
    const stdout = await this.run(['new', '--json', '--workspace', workspace, '--window', windowName, '--', ...command]);
    const pane = JSON.parse(stdout) as NewPaneJson;
    return {
      ref: JSON.stringify({ kind: 'misao', workspace: pane.workspace, window: pane.window.id }),
      workspace: pane.workspace,
      windowId: pane.window.id,
      windowName: pane.window.name,
      paneId: pane.paneId,
    };
  }

  /** 記録した PID にだけ SIGTERM を送り、終わらなければ同じ PID に SIGKILL する。 */
  async stopProcess(): Promise<void> {
    if (this.process.exitCode !== null || this.process.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => this.process.once('exit', () => resolve()));
    process.kill(this.pid, 'SIGTERM');
    const timedOut = await Promise.race([
      exited.then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), DAEMON_STOP_TIMEOUT_MS)),
    ]);
    if (timedOut) {
      process.kill(this.pid, 'SIGKILL');
      await exited;
    }
  }

  async stop(): Promise<void> {
    await this.stopProcess();
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

/** 常駐デーモンの設定を拾わないよう、MISAO_* を一時ソケットだけに固定した環境。 */
function isolatedEnv(socketPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, MISAO_SOCKET: socketPath };
  delete env.MISAO_DIR;
  delete env.MISAO_CONFIG;
  return env;
}
