// ─── 起動後検証（Issue #540） ───
//
// respawn / legacy recovery が Claude（attach または --resume）の起動行を pane のシェルに打った後、その起動が
// 実際に受け取られたかを確かめる。Claude Code が daemon 保持の会話を --resume で断るように、CLI は起動行を
// メッセージを出して終了することがある — 何も見なければ pane は黙ってシェルに戻り、オペレーターは窓が壊れた
// のか復帰が断られたのか分からない。ここでは pane の子孫プロセスに claude 実行体が立ったか（agentProcessDetection
// の既存判定）だけを見る。画面テキストのパターン照合はしない: worker の画面は版で変わるが、プロセスは立つ。
//
// 判定は純粋関数（workerRunningInSnapshot）、待ちと I/O は verifyLaunchedWorker に分ける。検証はタスク窓から
// 呼ぶ（実行ログと通知のために taskId/unitId と logRepo/events が要る。plain 窓は検証しない — そこは人が見る）。
//
// 誤検知（起動は進んでいるのにまだプロセスが立っていない）に備えて 2 回見る: 1 回目の待ちで立っていなければ
// 2 回目の待ちの後に同じスナップショット方式で見直す。それでも立っていなければ pane の画面の末尾（CLI の
// 拒否メッセージが残っている）を取り、呼び出し側が実行ログと通知に出す。この検証自体は窓を壊さない:
// 何も kill せず status も変えず、報告だけする。

import { isAgentProcessRunning } from '../transcripts/agentProcessDetection';
import type { ProcessEntry } from '../../shared/os/processList';
import type { IMuxClient } from '../tmux/IMuxClient';
import type { PaneHandle } from '@azito/shared';
import type { ServerConfig } from '../servers/Server';

/** The pane's process tree is looked at this long after the launch line was typed, and once more this much later. */
export const VERIFY_FIRST_WAIT_MS = 3_000;
export const VERIFY_SECOND_WAIT_MS = 3_000;

/** How many screen lines the failure report keeps, counted from the bottom (`captureScreen`'s `start` is negative for that — the CLI's refusal message sits at the bottom). */
export const VERIFY_SCREEN_LINES = 10;

/**
 * 純粋判定: pane の pid とその子孫の中に claude/codex 実行体が立っているか。pane の pid が取れない
 * （窓がもうない、pid の記録が間に合わない）ときは判定不能 — 起動していないとは言えないので false にはしないで
 * 呼び出し側に検証スキップさせるため null を返す。
 */
export function workerRunningInSnapshot(entries: ProcessEntry[], panePid: number | null): boolean | null {
  if (panePid === null) return null;
  return isAgentProcessRunning(entries, panePid);
}

/** What the verification needs from the host. All reads, nothing written. */
export interface VerifyLaunchedIo {
  driver: IMuxClient;
  server: ServerConfig;
  handle: PaneHandle;
  listProcesses: () => Promise<ProcessEntry[]>;
  /** The waits between the probes. Production: a real timer; tests pass an immediate one. */
  sleep?: (ms: number) => Promise<void>;
}

export interface VerifyLaunchedResult {
  /** Whether a worker process was found in the pane's process tree. */
  running: boolean;
  /** The pane screen's last lines when it was not (the CLI's refusal message), or null when they could not be read. */
  screenTail: string | null;
  /** Why the check could not be answered at all (a process listing or pane pid that could not be read): empty when it was. */
  unverifiableReason: string;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One probe: the pane's pid now and whether the process snapshot taken now finds a worker under it. */
async function probeOnce(io: VerifyLaunchedIo): Promise<{ verdict: boolean | null; panePid: number | null; unverifiableReason: string }> {
  let panePid: number | null = null;
  try {
    panePid = await io.driver.panePidByHandle(io.server, io.handle);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { verdict: null, panePid: null, unverifiableReason: `pane pid could not be read: ${reason}` };
  }
  if (panePid === null) return { verdict: null, panePid: null, unverifiableReason: 'the pane has no pid (the window is gone?)' };
  let entries: ProcessEntry[];
  try {
    entries = await io.listProcesses();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { verdict: null, panePid, unverifiableReason: `the process list could not be read: ${reason}` };
  }
  return { verdict: workerRunningInSnapshot(entries, panePid), panePid, unverifiableReason: '' };
}

/**
 * Sends nothing, kills nothing: looks at the pane's process tree, and when no worker stands there yet, waits and looks
 * again — twice in all, so a worker that is merely slow to start is not taken for a refused launch. A check that
 * cannot be answered (no process list, no pane pid) is reported through `unverifiableReason` and leaves the pane as
 * it is — the caller decides whether that is worth a log line; it is never taken as "the launch failed".
 */
export async function verifyLaunchedWorker(io: VerifyLaunchedIo): Promise<VerifyLaunchedResult> {
  const sleep = io.sleep ?? defaultSleep;
  // The first look is immediate: a worker that is already up needs no wait, and a pane whose pid cannot even be read
  // never gets one (an unverifiable check does not report a launch failure).
  let probe = await probeOnce(io);
  for (const waitMs of [VERIFY_FIRST_WAIT_MS, VERIFY_SECOND_WAIT_MS]) {
    if (probe.verdict === null || probe.verdict === true) {
      return { running: probe.verdict === true, screenTail: null, unverifiableReason: probe.unverifiableReason };
    }
    await sleep(waitMs);
    probe = await probeOnce(io);
  }
  if (probe.verdict === null || probe.verdict === true) {
    return { running: probe.verdict === true, screenTail: null, unverifiableReason: probe.unverifiableReason };
  }
  let screenTail: string | null = null;
  try {
    screenTail = (await io.driver.captureScreen(io.server, io.handle, -VERIFY_SCREEN_LINES)).stdout.trim() || null;
  } catch {
    screenTail = null;
  }
  return { running: false, screenTail, unverifiableReason: '' };
}
