import type { Window, PaneLayout } from '../windows/Window';
import type { ITaskRepository } from '../tasks/Task';
import type { TmuxClient, TmuxPaneInfo } from '../tmux/TmuxClient';
import type { IServerRepository, ServerConfig } from '../servers/Server';
import { windowSpecMatches } from '../tmux/TmuxClient';
import { stripPaneSuffix } from '../windows/paneTarget';
import type { SessionCaptureService } from '../windows/SessionCaptureService';
import type { TranscriptSource } from './sources/TranscriptSource';
import { parsePsOutput, isAgentProcessRunning, findAgentProcessStartMs, findAgentProcessTypes, argsContainSessionId } from './agentProcessDetection';
import type { PsEntry } from './agentProcessDetection';

// ─── Types ───

export type WindowSessionResolution =
  | { resolved: true; agentType: string; sessionId: string; paneId: string; agentDetected: boolean }
  | {
      resolved: false;
      reason: 'unsupported_server' | 'no_recent_session';
      /** best-effort な pane 解決結果（セッション未解決でもウィンドウ直接入力のために提供する。Issue #69 仕様調整3）。 */
      paneId?: string;
      agentType?: string;
      agentDetected: boolean;
    };

// ─── Constants ───

/** 直近この時間以内に更新されたセッションのみ「動作中」とみなす（cwd 照合フォールバック、優先順位3）。 */
const RECENT_SESSION_WINDOW_MS = 30 * 60 * 1000;
/** pane_current_command がこれに一致すれば「エージェントが動いていそうな pane」として優先する（node 系フォールバック、下記 selectPane 参照）。 */
const AGENT_COMMAND_PATTERN = /^(node|claude|codex)/i;
/** ソースとして自動解決に対応する workerType（= TranscriptSource.agentType と一致するもの）。generic 等は非対応。 */
const SUPPORTED_WORKER_TYPES = new Set(['claude', 'codex']);
/** pane_current_command がこれと完全一致すれば最優先でエージェント pane とみなす。 */
const AGENT_COMMAND_EXACT = new Set(['claude', 'codex']);
/**
 * agentDetected 判定レイヤー3（セッション活動シグナル）: 解決済みセッションの JSONL がこの時間
 * 以内に更新されていれば、エージェントが実際に書き込み中＝生きているとみなす。
 */
export const SESSION_ACTIVITY_WINDOW_MS = 120 * 1000;
/** レイヤー2（プロセス実体検査）／プロセス起動時刻ゲートの `ps` 実行に使うコマンド。pid/ppid/etimes/args を取得する。 */
const PS_COMMAND = 'ps -e -o pid=,ppid=,etimes=,args=';
/**
 * プロセス起動時刻ゲート（Issue #338 フォロー）: tier1（window 由来）/tier2（task 由来）の猶予。
 * この2層はウィンドウ/タスクがそのセッションIDと明示的に紐付いている記録（誤紐付けの事前確率が
 * 低い）なので、tier3（cwd 照合フォールバック、事前確率が高い＝厳格に絞るべき）より大きく取る。
 * supervisor 経由の起動は「セッションファイル作成 → プロセス起動」の順になり得（実機確認: resume/
 * 事前作成セッションでファイル mtime がプロセス起動より前で、その後書き込みが無い限りその前後関係が
 * 維持される）、この逆転が正常系で数十秒規模で起き得るため、mtime 単独では tier1/2 を安全に絞れない
 * （このゲートは主に「別の（無関係な）古いセッション」の誤紐付け防止が目的で、tier1/2 は既に
 * 明示的な紐付け記録がある分、より広い猶予を許容できる）。
 */
const EXPLICIT_LINK_SKEW_MS = 180 * 1000;
/**
 * プロセス起動時刻ゲート（Issue #338）: tier3（cwd 照合フォールバック）の猶予。cwd が一致するだけの
 * 推測的な紐付けなので、厳格な猶予を維持する。
 */
const CWD_MATCH_SKEW_MS = 15 * 1000;
/**
 * tier3 作成時刻一致の猶予（Issue #338 フォロー）: 「このプロセスが作ったセッション」を mtime の
 * 古さに関わらず正当な候補として拾うための判定に使う。セッションの作成時刻がプロセス起動時刻の
 * この範囲内であれば、そのプロセスが作ったセッションとみなす（アイドルで長時間 mtime が更新されて
 * いない既存会話でも正しく拾える）。CWD_MATCH_SKEW_MS（mtime 側、15秒）より広く取る — こちらは
 * 作成時刻という決定的に近い証拠を使うため、通常の起動オーバーヘッドのブレを許容してよい。
 */
const SESSION_CREATION_SKEW_MS = 5 * 60 * 1000;

/**
 * プロセス起動時刻ゲート（Issue #338）の状態。resolve() の先頭で一度だけ計算し、window/task/cwd
 * 各解決層の候補セッション受理判定に使い回す:
 * - 'unavailable': ゲート適用不可（非local サーバー、または tmux/ps 呼び出し失敗）。全層で従来
 *   挙動（実在確認のみ／cwd 層は30分ルール）を維持する — ゲート不能を理由に unresolved に倒すと
 *   非local 等でセッション解決が機能全損するため。
 * - 'not_detected': ps 実行は成功したが、このウィンドウのどの pane にも claude/codex プロセスが
 *   見つからなかった（=単なる bash pane 等）。window/task 直接リンク層（1/2）はウィンドウ自身の
 *   明示的な紐付けなので実在確認のみで従来通り通す一方、cwd 照合フォールバック層（3）は無効化する
 *   — bash pane が cwd 一致だけで無関係な古いセッションに紐付いてしまう、今回の報告と同型の誤爆を
 *   防ぐため。
 * - 'detected': claude/codex プロセスを検出できた。processStartMs 以降に更新されていない候補は
 *   全層で拒否する。agentTypes は実際にこのウィンドウの pane 群で見つかった実行体の種別集合
 *   （通常は単一。claude/codex 両方を別 pane で動かしている場合のみ2件）— cwd 照合フォールバック
 *   （優先順位3）の候補ソースをこの集合に限定するために使う（下記 resolveViaCwdMatch 参照。
 *   Issue #338フォロー: 同 cwd に存在する「別ウィンドウで生きている別種エージェントのセッション」
 *   を、mtime が新しいというだけで誤って拾ってしまうバグの修正）。
 */
type ProcessGateState =
  | { kind: 'unavailable' }
  | { kind: 'not_detected' }
  | { kind: 'detected'; processStartMs: number; agentTypes: Set<'claude' | 'codex'> };

function toGateState(
  detection: { entries: PsEntry[]; processStartMs: number | null; agentTypes: Set<'claude' | 'codex'> } | null,
): ProcessGateState {
  if (detection === null) return { kind: 'unavailable' };
  if (detection.processStartMs === null) return { kind: 'not_detected' };
  return { kind: 'detected', processStartMs: detection.processStartMs, agentTypes: detection.agentTypes };
}

// ─── Helpers ───

export function splitWindowTarget(tmuxTarget: string): { sessionName: string; windowSpec: string } {
  const stripped = stripPaneSuffix(tmuxTarget);
  const colonIndex = stripped.indexOf(':');
  if (colonIndex === -1) return { sessionName: stripped, windowSpec: '' };
  return { sessionName: stripped.slice(0, colonIndex), windowSpec: stripped.slice(colonIndex + 1) };
}

/**
 * window.paneLayout に、解決済みセッション（sessionId優先、なければ workerType）に対応するメタがあれば
 * そのペインを返す（優先順位・最優先）。paneLayout はウィンドウ作成時に確定したペイン構成のメタデータで、
 * pane_current_command のようなランタイム状態のブレに影響されない。
 */
function findPaneLayoutMatch(
  paneLayout: PaneLayout | null,
  windowPanes: TmuxPaneInfo[],
  resolvedSessionId: string,
  resolvedAgentType: string,
): string | null {
  if (!paneLayout) return null;

  const bySessionId = paneLayout.panes.find((p) => p.agentSessionId === resolvedSessionId);
  const metaPane = bySessionId ?? paneLayout.panes.find((p) => p.workerType === resolvedAgentType);
  if (!metaPane) return null;

  const match = windowPanes.find((p) => p.paneIndex === metaPane.index);
  return match?.paneId ?? null;
}

/** 「エージェントが動いていそうな pane」を選ぶ。paneLayout メタ → command 完全一致 → アクティブ pane → node 系 → 先頭 pane の順。 */
function selectPane(
  panes: TmuxPaneInfo[],
  activePaneIndex: number | null,
  paneLayout: PaneLayout | null,
  resolvedSessionId: string,
  resolvedAgentType: string,
): string | null {
  const metaMatch = findPaneLayoutMatch(paneLayout, panes, resolvedSessionId, resolvedAgentType);
  if (metaMatch) return metaMatch;

  const exactMatch = panes.find((p) => AGENT_COMMAND_EXACT.has(p.currentCommand.toLowerCase()));
  if (exactMatch) return exactMatch.paneId;

  if (activePaneIndex !== null) {
    const active = panes.find((p) => p.paneIndex === activePaneIndex);
    if (active) return active.paneId;
  }

  const nodeMatch = panes.find((p) => AGENT_COMMAND_PATTERN.test(p.currentCommand));
  if (nodeMatch) return nodeMatch.paneId;

  return panes[0]?.paneId ?? null;
}

// ─── Service ───

/**
 * windows テーブルの1行から「そのウィンドウで動いているエージェントの会話セッション」を自動解決する
 * サービス（Issue #69 Phase E-1）。手動のセッション選択（TranscriptPaneService.listPaneCandidates に
 * よるユーザー選択）の前段として、優先順位つきで自動判定を試みる:
 *
 * 1. ウィンドウ自身のセッション: window.agentSessionId があれば、window.workerType に対応するソース
 *    （claude/codex。generic 等未対応 workerType は次の優先順位へ）で実在確認して採用する。プロジェクト
 *    直属ウィンドウ（taskId が null）もここで解決できる。
 * 2. タスク連携: window.taskId に紐づく task の agent_session_id を採用する。ソース選択は window.workerType
 *    に従い（claude/codex ならそれ固定）、workerType が不明/未対応な場合は全ソースを実在確認で総当たりする。
 * 3. cwd 照合フォールバック: このウィンドウの pane の cwd と、全 TranscriptSource のセッション一覧の cwd を
 *    突合し、直近 30 分以内に更新された最新セッションを採用（claude/codex 横断）。
 * 4. pane 選定: 上記いずれかで解決したセッションに対し、window.paneLayout にそのセッション/workerType の
 *    メタがあれば最優先で採用し、無ければ pane_current_command が claude/codex に完全一致する pane、
 *    無ければアクティブ pane、それも無ければ node 系 pane、最後に先頭 pane を返す。選定した pane の
 *    agentDetected は detectAgent() が別途多層判定する（コマンド完全一致 → プロセス実体検査 →
 *    セッション活動シグナル）。
 *
 * セッション自動解決自体はローカルサーバーのみ対応（Phase E-1 時点。SSH/agent サーバーは
 * 'unsupported_server'）。ただし pane 解決（優先順位4のロジック）自体は tmux コマンドの
 * トランスポート抽象化により全サーバー種別で動作するため、セッションが解決できない場合でも
 * best-effort で paneId・window.workerType 由来の agentType を返す（Issue #69 仕様調整3。
 * ウィンドウ直接入力 API がセッション JSONL 未作成でもチャットを開始できるようにするため）。
 * server 自体が見つからない場合（window.serverName が指す ServerConfig が存在しない）は
 * tmux コマンドを打つ先すら無いため best-effort もできない。
 *
 * プロセス起動時刻ゲート（Issue #338）: 優先順位1〜3で見つかった候補セッションは、採用前に
 * 「mtime ≧ 現在のこのウィンドウで動作中のエージェントプロセスの起動時刻 − 猶予」を満たすか
 * 検査される（`claude --resume` 等の再開は書き込みが継続するため mtime が更新され続け、正しく
 * 通る）。ウィンドウを閉じて同じ cwd で新しい claude を開いた直後（旧セッションの mtime がプロセス
 * 開始より前で止まっている）はこの検査で棄却され、unresolved（pane-only モード）へ倒れる —
 * 新セッションの JSONL が実際に書かれ始めれば、次回の解決（既存のポーリング）で新セッションに
 * 昇格する。詳細は ProcessGateState のコメントを参照。
 */
export class WindowSessionResolver {
  constructor(
    private readonly taskRepo: ITaskRepository,
    private readonly tmuxClient: TmuxClient,
    private readonly serverRepo: IServerRepository,
    private readonly sources: TranscriptSource[],
    private readonly sessionCaptureService: SessionCaptureService,
  ) {}

  async resolve(window: Window): Promise<WindowSessionResolution> {
    const server = this.serverRepo.findByName(window.serverName);
    if (!server) {
      return { resolved: false, reason: 'unsupported_server', agentDetected: false };
    }

    const windowPanes = await this.getWindowPanes(server, window);
    const isLocal = server.type === 'local';

    let gate: ProcessGateState = { kind: 'unavailable' };
    let psEntries: PsEntry[] | null = null;
    let rootPids: number[] = [];

    if (isLocal) {
      const detection = await this.detectWindowAgentProcess(server, windowPanes);
      gate = toGateState(detection);
      psEntries = detection?.entries ?? null;
      rootPids = detection?.rootPids ?? [];

      const windowLinked = this.resolveViaWindow(window);
      if (windowLinked && this.passesSessionGate(gate, windowLinked.agentType, windowLinked.sessionId, EXPLICIT_LINK_SKEW_MS, psEntries, rootPids)) {
        const pane = await this.resolvePaneWithDetection(server, window, windowPanes, windowLinked.sessionId, windowLinked.agentType, psEntries);
        if (pane) return { resolved: true, agentType: windowLinked.agentType, sessionId: windowLinked.sessionId, ...pane };
      }

      const taskLinked = this.resolveViaTask(window);
      if (taskLinked && this.passesSessionGate(gate, taskLinked.agentType, taskLinked.sessionId, EXPLICIT_LINK_SKEW_MS, psEntries, rootPids)) {
        const pane = await this.resolvePaneWithDetection(server, window, windowPanes, taskLinked.sessionId, taskLinked.agentType, psEntries);
        if (pane) return { resolved: true, agentType: taskLinked.agentType, sessionId: taskLinked.sessionId, ...pane };
      }

      // gate が 'not_detected'（このウィンドウのどの pane にも claude/codex が居ない）の場合、
      // cwd 照合フォールバックは行わない。tier1/2 はウィンドウ/タスクがそのセッションと明示的に
      // 紐付いている記録なので存置する一方、tier3 は cwd が一致するだけで他ウィンドウ由来の
      // セッションを拾ってしまい得るため、エージェントが実際には動いていない pane（bash に戻った
      // 等）に別セッションの会話を誤って紐付けるバグ（今回の実機報告と同型）を再発させないため。
      if (gate.kind !== 'not_detected') {
        // gate が 'detected' の場合、cwd 照合フォールバックの候補ソースを実際にこのウィンドウで
        // 検出できたエージェント種別に限定する（Issue #338フォロー）。同 cwd に「別ウィンドウで
        // 生きている別種エージェントのセッション」が存在しても、そちらは mtime が新しいだけで
        // このウィンドウの実行体とは無関係なため拾わない。
        const allowedAgentTypes = gate.kind === 'detected' ? gate.agentTypes : null;
        const processStartMs = gate.kind === 'detected' ? gate.processStartMs : null;
        const cwdMatched = this.resolveViaCwdMatch(windowPanes, allowedAgentTypes, processStartMs);
        // 作成時刻一致で採用した候補（cwdMatched.viaCreationMatch）は、mtime が古くても
        // 「このプロセスが作ったセッション」という決定的な証拠で既に採用可否を判定済みなので、
        // 通常の mtime ベースの passesSessionGate は再適用しない（適用すると古い mtime で
        // 棄却されてしまい、この tier3 拡張の意味がなくなる）。
        if (cwdMatched && (cwdMatched.viaCreationMatch || this.passesSessionGate(gate, cwdMatched.agentType, cwdMatched.sessionId, CWD_MATCH_SKEW_MS, psEntries, rootPids))) {
          const pane = await this.resolvePaneWithDetection(server, window, windowPanes, cwdMatched.sessionId, cwdMatched.agentType, psEntries);
          if (pane) {
            // tier3（cwd 照合フォールバック）でのみ解決結果を windows テーブルへ書き戻す（Issue #338）。
            // window.agentSessionId が未設定のウィンドウで respawn 後の再解決コストを下げるため。
            // tier1（window 由来）は既に書き込み済みで対象外。tier2（task 由来）は
            // SessionCaptureService.adoptResolvedSession 内の isAssigned ガードが「そのタスク自身への
            // 割当」を検出して常に書き込みを拒否するため、自然に書き戻しをスキップする。
            this.sessionCaptureService.adoptResolvedSession(window.id, cwdMatched.sessionId);
            return { resolved: true, agentType: cwdMatched.agentType, sessionId: cwdMatched.sessionId, ...pane };
          }
        }
      }
    }

    const reason: 'unsupported_server' | 'no_recent_session' = isLocal ? 'no_recent_session' : 'unsupported_server';
    // best-effort な agentType の既定は workerType > プロセス検出（単一種別のみ判明している場合）
    // > 既定なし。既定を 'claude' 等に倒すと未検出時に誤表示するため、判明しなければ undefined のまま
    // フロントの警告表示に委ねる（Issue #338フォロー）。
    const detectedType = gate.kind === 'detected' && gate.agentTypes.size === 1 ? [...gate.agentTypes][0] : undefined;
    const fallbackAgentType = window.workerType ?? detectedType;
    const fallback = await this.resolvePaneWithDetection(server, window, windowPanes, '', fallbackAgentType ?? '', psEntries);
    if (!fallback) return { resolved: false, reason, agentDetected: false };
    return { resolved: false, reason, paneId: fallback.paneId, agentType: fallbackAgentType, agentDetected: fallback.agentDetected };
  }

  /**
   * 軽量な三値の稼働判定（Issue #338 フォロー、AZITO監視強化: agent-activity が hook/supervisor
   * 接続を前提とするのに対し、こちらは resolve() のレイヤー2（プロセス実体検査）・レイヤー3
   * （セッション mtime 活動シグナル、SESSION_ACTIVITY_WINDOW_MS を共有）だけを使い、hook/supervisor
   * の配線が無いウィンドウ（手動で立てた codex/claude ペイン等）でも「実際に動いているか」を
   * 判定できるようにする。resolve() 自体（セッション*解決*のための優先順位付きロジック）とは別の
   * 軽量パスとして独立させてある — 呼び出し元（WindowActivityStatusService）は「このウィンドウの
   * どれかの pane に claude/codex プロセスが存在するか」「window/task に紐づくセッションが直近
   * 書き込まれているか」だけを知りたく、cwd 照合フォールバック等の解決優先順位は不要なため。
   *
   * - 'offline': server が見つからない／非local／pane が無い／ps 呼び出し失敗／どの pane にも
   *   claude/codex プロセスが見当たらない。
   * - 'working': プロセスは見つかり、かつ window.agentSessionId（無ければ紐づく task の
   *   agentSessionId）のセッションファイルが直近 SESSION_ACTIVITY_WINDOW_MS 以内に更新されており、
   *   かつ末尾レコードが tailState 'terminal_interrupted'（中断マーカー）／'terminal_local'（ローカル
   *   コマンド完了）のいずれでもない。tailState が 'terminal_final'（最終応答完了）または 'unknown'
   *   の場合は working のままとする — mtime 120秒窓の間は「直近まで動いていた」ことを見せ続け、
   *   working→idle 遷移での完了行合成の観測窓を確保する（Issue #338 followup 退行修正: 20秒程度の
   *   短いターンが一度も working を観測されず稼働リストに現れなくなっていた不具合の修正。詳細は
   *   entryHelpers.ts classifyTailEntry のコメント参照）。
   * - 'idle': プロセスは見つかったが、セッションが未設定、セッション mtime が古い
   *   （エージェントプロセス自体は生きているがユーザー入力待ち等で書き込みが止まっている）、または
   *   mtime は新しいが tailState が 'terminal_interrupted'（停止ボタン等によるユーザー中断。中断
   *   マーカー自体の書き込みで mtime が更新されるため、mtime だけでは「稼働中」の偽陽性が生じる —
   *   末尾レコードの意味まで見て排除する）／'terminal_local'（/model 等のローカルコマンド実行完了。
   *   エージェントのターンを開始していないため working として見せ続ける理由がなく、同様に mtime
   *   だけでは偽陽性が生じる — Issue #338 コードレビュー指摘）。terminal_final はここに含めない。
   */
  async getActivityStatus(window: Window): Promise<'working' | 'idle' | 'offline'> {
    const server = this.serverRepo.findByName(window.serverName);
    if (!server || server.type !== 'local') return 'offline';

    const windowPanes = await this.getWindowPanes(server, window);
    const detection = await this.detectWindowAgentProcess(server, windowPanes);
    if (!detection || detection.processStartMs === null) return 'offline';

    const sessionId = window.agentSessionId
      ?? (window.taskId !== null ? this.taskRepo.findById(window.taskId)?.agentSessionId ?? null : null);
    if (!sessionId) return 'idle';

    const agentType = window.workerType
      ?? (detection.agentTypes.size === 1 ? [...detection.agentTypes][0] : null);
    if (!agentType) return 'idle';

    const source = this.sources.find((s) => s.agentType === agentType);
    const mtimeMs = source?.getSessionMtimeMs(sessionId) ?? null;
    if (mtimeMs === null || Date.now() - mtimeMs > SESSION_ACTIVITY_WINDOW_MS) return 'idle';

    const tailState = source ? await source.getSessionTailState(sessionId) : 'unknown';
    if (tailState === 'terminal_interrupted' || tailState === 'terminal_local') return 'idle';
    return 'working';
  }

  /**
   * プロセス起動時刻ゲート（Issue #338）: 候補セッションが「現在動作中のエージェントプロセスの
   * 起動より後に更新されているか」を検査する。gate.kind !== 'detected' の場合はゲート適用不能
   * （非local／ps失敗／エージェント不検出）として常に true を返し、呼び出し元の従来挙動に委ねる
   * （'not_detected' 時の tier3 無効化は resolve() 側で別途行う）。
   *
   * 最優先の証拠として、まずプロセス引数によるセッションID照合（argsContainSessionId、Issue #338
   * フォロー）を試みる。ウィンドウの pane 群の子孫プロセスの実引数に candidate sessionId がそのまま
   * 含まれていれば（`codex resume <id>` / `claude --resume <id>` 等）、mtime の前後関係に関わらず
   * 「このプロセスが実際にこのセッションを再開して動いている」決定的な証拠として即座に受理する
   * （supervisor 経由の起動でファイル作成がプロセス起動に先行するケースを正しく拾うため）。
   *
   * 引数照合で判定できなければ mtime ゲートにフォールバックする。mtime が取得できない候補は
   * 安全側で棄却する（resume で書き込み継続中のセッションなら mtime は必ず取得できるはずで、
   * 取れない＝別のセッションとみなせる）。skewMs は呼び出し元の tier（tier1/2 か tier3 か）で
   * 異なる猶予を渡す。
   */
  private passesSessionGate(
    gate: ProcessGateState,
    agentType: string,
    sessionId: string,
    skewMs: number,
    psEntries: PsEntry[] | null,
    rootPids: number[],
  ): boolean {
    if (gate.kind !== 'detected') return true;
    if (psEntries && argsContainSessionId(psEntries, rootPids, sessionId)) return true;
    const source = this.sources.find((s) => s.agentType === agentType);
    const mtimeMs = source?.getSessionMtimeMs(sessionId) ?? null;
    if (mtimeMs === null) return false;
    return mtimeMs >= gate.processStartMs - skewMs;
  }

  /**
   * プロセス起動時刻ゲート用の検出。ウィンドウの pane 群の pid を辿り、`ps -e -o
   * pid=,ppid=,etimes=,args=` を1回実行してその子孫に claude/codex 実行体が無いか調べる
   * （detectAgent() のレイヤー2と同じ探索ロジック／同じ ps 結果を再利用し、ps を二重実行しない
   * — 呼び出し元がここで得た entries を resolvePaneWithDetection 経由で detectAgent() にも渡す）。
   * 検出できれば起動時刻（複数一致時は最古。findAgentProcessStartMs 参照）を processStartMs として
   * 返す。pane ごとに解決できた pid（rootPids）も合わせて返す — 引数によるセッションID照合
   * （argsContainSessionId、Issue #338フォロー）が、このウィンドウの pane 群の子孫プロセスに限定して
   * 探索するために使う。
   *
   * 戻り値 null は「ゲート適用不能」（tmux/ps 呼び出し失敗）。processStartMs が null（entries は
   * 取得できたがどの pane にも一致が無い）は「不検出」を意味し、resolve() 側でゲートの意味が
   * 変わる（'not_detected' として tier3 を無効化する）。
   */
  private async detectWindowAgentProcess(
    server: ServerConfig,
    windowPanes: TmuxPaneInfo[],
  ): Promise<{ entries: PsEntry[]; processStartMs: number | null; agentTypes: Set<'claude' | 'codex'>; rootPids: number[] } | null> {
    if (windowPanes.length === 0) return null;
    try {
      const { stdout, code } = await this.tmuxClient.execCommand(server, PS_COMMAND);
      if (code !== 0) return null;
      const entries = parsePsOutput(stdout);
      const now = Date.now();

      let processStartMs: number | null = null;
      const agentTypes = new Set<'claude' | 'codex'>();
      const rootPids: number[] = [];
      for (const pane of windowPanes) {
        const pid = await this.tmuxClient.getPanePid(server, pane.paneId);
        if (pid === null) continue;
        rootPids.push(pid);
        const startMs = findAgentProcessStartMs(entries, pid, now);
        if (startMs !== null && (processStartMs === null || startMs < processStartMs)) {
          processStartMs = startMs;
        }
        for (const type of findAgentProcessTypes(entries, pid)) agentTypes.add(type);
      }
      return { entries, processStartMs, agentTypes, rootPids };
    } catch {
      return null;
    }
  }

  /** 優先順位1: ウィンドウ自身のセッション。session が存在しなければ null（呼び出し元がフォールバックする）。 */
  private resolveViaWindow(window: Window): { agentType: string; sessionId: string } | null {
    if (!window.agentSessionId) return null;
    return this.resolveSessionForId(window.agentSessionId, window.workerType);
  }

  /** 優先順位2: タスク連携。session が存在しなければ null（呼び出し元がフォールバックする）。 */
  private resolveViaTask(window: Window): { agentType: string; sessionId: string } | null {
    if (window.taskId === null) return null;
    const task = this.taskRepo.findById(window.taskId);
    if (!task || !task.agentSessionId) return null;
    return this.resolveSessionForId(task.agentSessionId, window.workerType);
  }

  /**
   * sessionId が実在するソースを、workerType（対応: claude/codex）で選ぶ。workerType が未対応/不明な
   * 場合は全ソースを実在確認で総当たりする。
   */
  private resolveSessionForId(sessionId: string, workerType: string | null): { agentType: string; sessionId: string } | null {
    if (workerType !== null && SUPPORTED_WORKER_TYPES.has(workerType)) {
      const source = this.sources.find((s) => s.agentType === workerType);
      if (!source) return null;
      const meta = source.getSessionCwd(sessionId);
      if (!meta) return null; // セッションファイルが実在しない（不正な session id を含む）
      return { agentType: workerType, sessionId };
    }

    for (const source of this.sources) {
      const meta = source.getSessionCwd(sessionId);
      if (meta) return { agentType: source.agentType, sessionId };
    }
    return null;
  }

  /**
   * 優先順位3: cwd 照合フォールバック。
   * allowedAgentTypes が渡された場合（プロセス検出でこのウィンドウの実行体種別が判明している
   * 場合）、候補をその種別のソースに限定する（Issue #338フォロー）。同 cwd で別ウィンドウの
   * 別種エージェントが活動中でも、そのセッションは対象外にする — mtime だけで選ぶと、そちらが
   * より新しいというだけで誤って採用してしまう（実機報告: codex ペインに claude セッションが
   * 紐付く）。null（プロセス検出不能、gate.kind !== 'detected'）の場合は従来通り全ソース対象。
   *
   * 採用順位（Issue #338 フォロー）:
   * 1. 作成時刻一致: processStartMs が判明していれば、候補の作成時刻がその ±SESSION_CREATION_SKEW_MS
   *    以内のものを最優先で採用する（複数あれば最も近いもの）。「このプロセスが作ったセッション」なら
   *    mtime がどれだけ古くても（アイドルで長時間書き込みが無くても）正当な候補 — 30分ルール
   *    （RECENT_SESSION_WINDOW_MS）より優先する。呼び出し元に viaCreationMatch:true を返し、
   *    通常の mtime ベースの起動時刻ゲート（passesSessionGate）を再適用させない。
   * 2. mtime 最新: 上記が無ければ従来通り、直近 RECENT_SESSION_WINDOW_MS 以内で mtime 最新のものを
   *    採用する（呼び出し元が passesSessionGate で追加検査する）。
   */
  private resolveViaCwdMatch(
    windowPanes: TmuxPaneInfo[],
    allowedAgentTypes: Set<'claude' | 'codex'> | null,
    processStartMs: number | null,
  ): { agentType: string; sessionId: string; viaCreationMatch: boolean } | null {
    const windowCwds = new Set(windowPanes.map((p) => p.currentPath).filter((cwd) => cwd.length > 0));
    if (windowCwds.size === 0) return null;

    const eligibleSources = this.sources.filter(
      (source) => allowedAgentTypes === null || allowedAgentTypes.has(source.agentType as 'claude' | 'codex'),
    );
    const candidates = eligibleSources
      .flatMap((source) => source.listSessions())
      .filter((session) => session.cwd !== null && windowCwds.has(session.cwd));
    if (candidates.length === 0) return null;

    if (processStartMs !== null) {
      let best: { agentType: string; sessionId: string; diffMs: number } | null = null;
      for (const candidate of candidates) {
        const source = eligibleSources.find((s) => s.agentType === candidate.agentType);
        const createdMs = source?.getSessionCreatedMs(candidate.sessionId) ?? null;
        if (createdMs === null) continue;
        const diffMs = Math.abs(createdMs - processStartMs);
        if (diffMs > SESSION_CREATION_SKEW_MS) continue;
        if (best === null || diffMs < best.diffMs) {
          best = { agentType: candidate.agentType, sessionId: candidate.sessionId, diffMs };
        }
      }
      if (best) return { agentType: best.agentType, sessionId: best.sessionId, viaCreationMatch: true };
    }

    const latest = candidates.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
    if (Date.now() - latest.mtimeMs > RECENT_SESSION_WINDOW_MS) return null;

    return { agentType: latest.agentType, sessionId: latest.sessionId, viaCreationMatch: false };
  }

  private async getWindowPanes(server: ServerConfig, window: Window): Promise<TmuxPaneInfo[]> {
    const { sessionName, windowSpec } = splitWindowTarget(window.tmuxTarget);
    const allPanes = await this.tmuxClient.listAllPanes(server);
    return allPanes.filter((p) => p.sessionName === sessionName && windowSpecMatches(windowSpec, p.windowIndex, p.windowName));
  }

  /**
   * pane 選定（優先順位4）＋ agentDetected 判定を一度に行う。sessionId/agentType は解決済みセッションが
   * あれば渡す。best-effort 呼び出し時（セッション未解決）は sessionId='' / agentType=window.workerType ?? ''
   * を渡す — paneLayout メタは sessionId 空文字ではマッチせず、workerType 一致のみで判定される。
   * pane 未取得ならアクティブ pane 判定のため list-sessions を追加で1回引く（遅延評価）。
   * agentDetected の判定は detectAgent() に委譲する（多層判定、下記参照）。
   */
  private async resolvePaneWithDetection(
    server: ServerConfig,
    window: Window,
    windowPanes: TmuxPaneInfo[],
    sessionId: string,
    agentType: string,
    psEntries: PsEntry[] | null,
  ): Promise<{ paneId: string; agentDetected: boolean } | null> {
    if (windowPanes.length === 0) return null;

    // pane 選択には paneLayout メタを引き続き使う（Important #3 修正前と同じ優先順位）。ただし
    // agentDetected はここでは決定しない — メタは「作成時点でエージェント用と確定していた」ことしか
    // 示さず、その後エージェントが落ちて bash に戻った pane でも一致し続けるため、警告を誤って
    // 抑制してしまう。agentDetected は選択後に live な状態（コマンド／プロセス／セッション活動）から
    // 判定し直す。
    const metaMatch = findPaneLayoutMatch(window.paneLayout, windowPanes, sessionId, agentType);

    let paneId: string | null;
    if (metaMatch) {
      paneId = metaMatch;
    } else if (windowPanes.some((p) => AGENT_COMMAND_EXACT.has(p.currentCommand.toLowerCase()))) {
      paneId = selectPane(windowPanes, null, window.paneLayout, sessionId, agentType);
    } else {
      const activePaneIndex = await this.findActivePaneIndex(server, window);
      paneId = selectPane(windowPanes, activePaneIndex, window.paneLayout, sessionId, agentType);
    }
    if (!paneId) return null;

    const pane = windowPanes.find((p) => p.paneId === paneId);
    const agentDetected = await this.detectAgent(server, pane, sessionId, agentType, psEntries);
    return { paneId, agentDetected };
  }

  /**
   * agentDetected の多層判定。上位が真ならそこで確定し、下位の検査は行わない（無駄な ps/statSync を
   * 避ける）:
   *
   * 1. pane_current_command が claude/codex に完全一致（環境によってはこれで十分）。
   * 2. プロセス実体検査（local サーバーのみ）: Claude Code は node スクリプトとして起動するため、
   *    シェバン経由の exec では pane_current_command が "node" になり得る（実機確認済み）。pane_pid
   *    の子孫プロセスの実引数（ps args）を辿り、claude/codex 実行体があるか調べる。
   * 3. セッション活動シグナル: 解決済みセッション（sessionId 非空）の JSONL が直近
   *    SESSION_ACTIVITY_WINDOW_MS 以内に更新されていれば、エージェントが書き込み中＝生きているとみなす。
   * 4. いずれも偽なら false（警告表示は正当）。
   *
   * レイヤー2/3 は「検出できなかった」ことしか意味しない（tmux/ps 呼び出し失敗・非対応サーバー種別・
   * セッション未解決を含む）ため、下位レイヤーに委ねるだけで、誤って agentDetected を確定させることはない。
   *
   * レイヤー2が使う ps 結果（psEntries）は resolve() 側でプロセス起動時刻ゲート用に既に1回実行済みの
   * ものをそのまま受け取る（detectWindowAgentProcess 参照）。ここで改めて ps を実行しない。
   */
  private async detectAgent(
    server: ServerConfig,
    pane: TmuxPaneInfo | undefined,
    sessionId: string,
    agentType: string,
    psEntries: PsEntry[] | null,
  ): Promise<boolean> {
    if (pane === undefined) return false;

    if (AGENT_COMMAND_EXACT.has(pane.currentCommand.toLowerCase())) return true;

    if (server.type === 'local' && (await this.detectAgentProcess(server, pane.paneId, psEntries))) return true;

    if (sessionId) {
      const source = this.sources.find((s) => s.agentType === agentType);
      const mtimeMs = source?.getSessionMtimeMs(sessionId) ?? null;
      if (mtimeMs !== null && Date.now() - mtimeMs <= SESSION_ACTIVITY_WINDOW_MS) return true;
    }

    return false;
  }

  /**
   * レイヤー2の実処理。pane_pid を取得し、resolve() 側で1回実行済みの ps 結果（psEntries）から
   * その子孫に claude/codex 実行体が無いか調べる。psEntries が null（ゲート側で ps 自体が失敗した）
   * ならこのレイヤーの「検出できず」として false を返す（detectAgent 側のコメントの通り、これは
   * 誤って警告を消す方向には働かない）。
   */
  private async detectAgentProcess(server: ServerConfig, paneId: string, psEntries: PsEntry[] | null): Promise<boolean> {
    if (psEntries === null) return false;
    try {
      const pid = await this.tmuxClient.getPanePid(server, paneId);
      if (pid === null) return false;
      return isAgentProcessRunning(psEntries, pid);
    } catch {
      return false;
    }
  }

  private async findActivePaneIndex(server: ServerConfig, window: Window): Promise<number | null> {
    const { sessionName, windowSpec } = splitWindowTarget(window.tmuxTarget);
    const sessions = await this.tmuxClient.listSessions(server);
    const session = sessions.find((s) => s.name === sessionName);
    if (!session) return null;
    const win = session.windows.find((w) => windowSpecMatches(windowSpec, w.index, w.name));
    if (!win) return null;
    return win.panes.find((p) => p.active)?.index ?? null;
  }
}
