import type { IServerTransport } from './transport/ServerTransport';
import { shellQuote } from '../../shared/shellQuote';
import { isAzitoctlEnvFilename } from '../../shared/azitoctlEnv';
import { extractClaudeMcpUiToken, hasCodexConfigUiToken } from '../../shared/mcpTokenStores';
import type { HubCanary } from './hubCanary';
import { isCanaryStillIntact } from './hubCanary';

// ─── Isolation doctor (Issue #29 Step 2 B) ───
//
// Layer 2 ("検証") of the isolation profile design: where `isolationIntent`
// (Server.ts) is a DECLARATION the operator makes and layer 3
// (TaskPaneEnvironmentService / HarnessInstaller) enforces credential
// withholding on unconditionally, this module actually PROBES a live
// `agent`-type server for evidence that no operator-equivalent credential
// is reachable there. It never influences layer 3's decisions (declared
// intent alone still gates credential distribution — see Server.ts's
// isolationIntent doc comment); it only produces a report an operator (and
// the frontend) can read.
//
// Every check below is a SNAPSHOT taken at probe time, not a continuous
// guarantee — a credential could be written to the server the moment after
// a passing probe returns (TOCTOU). This module cannot close that gap; only
// re-running the probe (or a future execute-time re-verification, out of
// scope for this step) can. Callers must present `verified`/`isolationVerifiedAt`
// to operators as "as of this check", never as an ongoing promise.
//
// Fail-closed contract: a check that could not actually be verified (the
// prerequisite command/tool is unreachable, or its output was in an
// unrecognized shape) reports `'unknown'`, NEVER folded into `'pass'`. The
// overall `verified` flag is true only when EVERY check is `'pass'` — a
// single `'unknown'` or `'fail'` anywhere blocks it, matching the isolation
// gate's own "unable to prove clean means fail closed" philosophy
// (servers/routes.ts's checkIsolationBlockers).
//
// Doctrine (position ratified after review — see project decision record):
// the isolation doctor is a MISCONFIGURATION DETECTOR, not an attestation.
// Every probe here depends on self-reporting relayed through the agent
// process running ON the target host — `transport.exec()` asks that host to
// tell the truth about itself. When the host itself is adversarial (for
// example: it was compromised by an untrusted-input task that ran on an
// isolated server and tampered with the agent process or its environment),
// no probe in this file can be trusted, and no probe added later can fix
// that — self-reported evidence from a compromised reporter is not evidence.
// The actual defense against an adversarial host is structural, not
// probe-based: that host is never handed a credential worth stealing in the
// first place (layer 2, credential-distribution gate — declared
// `isolationIntent` unconditionally withholds operator-equivalent secrets
// from isolated servers; see Server.ts's isolationIntent doc comment and
// TaskPaneEnvironmentService/HarnessInstaller). This doctor's job is to
// confirm that structural gate is actually in the state the operator
// believes it's in — a health check on the gate, not a substitute
// assurance for hosts the gate doesn't cover. Because every individual
// check's spoofability already falls out of this doctrine, checks below do
// not each carry their own "but a hostile host could fake this" caveat —
// that concern is covered once, here, for the module as a whole.
//
// Tailnet membership (i.e. the lateral-movement reach a Tailscale SSH
// identity grants) is explicitly OUT OF SCOPE for this doctor — it is an
// operational responsibility of tailnet ACL / firewall rules, not something
// a per-server probe run from the hub can observe or enforce.

export type IsolationCheckStatus = 'pass' | 'fail' | 'unknown';

export interface IsolationCheck {
  id: string;
  status: IsolationCheckStatus;
  detail: string;
}

export interface IsolationDoctorResult {
  verified: boolean;
  checks: IsolationCheck[];
}

/** Hub-side identity resolved ONCE at the route boundary (Resolve at the
 * Boundary — main.ts/routes.ts owns process.env/os access, this module only
 * ever receives already-resolved values) and passed in, never re-read here. */
export interface HubIdentity {
  hostname: string;
  uid: number | null;
  /**
   * Review round (isolation doctor, Critical finding 1): the hub's own
   * FS-boundary canary (see hubCanary.ts) — a small non-secret marker file
   * written into the hub's data directory at startup. `null` when the write
   * failed (or the hub restarted with a read-only data dir); the FS-boundary
   * check degrades to 'unknown' rather than silently skipping the
   * measurement in that case. Resolved once by routes.ts (via
   * `getHubCanary()`) and passed in, matching this interface's own
   * "resolved at the boundary" contract.
   */
  canary: HubCanary | null;
  /**
   * Review round (same_host judgment restructure, Critical finding 1): the
   * hub's own Linux kernel boot id (`/proc/sys/kernel/random/boot_id`), read
   * once at the route boundary (`readHubBootId()` in routes.ts) — never
   * re-read here. `null` on a non-Linux hub (no such file, e.g. every
   * darwin/macOS hub build this project ships) or any read failure.
   *
   * `checkFsAndHostBoundary` no longer treats a matching value as decisive
   * proof of separation, nor a mismatch as one — boot_id CAN be virtualized
   * per-container (systemd-nspawn / LXC can each report a different value on
   * the SAME physical host), so a mismatch is not evidence of separation. A
   * MATCH is still trustworthy as evidence of a SHARED kernel (a container
   * cannot fake a different kernel, only spoof its own reported id), so it is
   * used only to strengthen `'fail'`. `pass` is decided solely by the FS
   * canary probe (see that function's doc comment) — this field never gates
   * reaching `pass`, so a hub with `bootId: null` can still verify.
   */
  bootId: string | null;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Review round (Minor finding 2): every probe in this module runs while
 * `routes.ts` holds a per-server mutex (`serverIsolationMutex`) for the
 * WHOLE doctor run, and for `agent`-type servers `transport.exec()` is an
 * unbounded `fetch()` under the hood (`AgentTransport`'s `post()` sets no
 * `AbortSignal` — the `timeoutMs` param it forwards only bounds the child
 * process the AGENT runs, not the hub-to-agent HTTP round trip itself). A
 * network partition to that agent (TCP blackhole: SYN/ACK completes but the
 * peer never replies) would otherwise stall on undici's ~300s default,
 * holding the mutex and blocking every OTHER isolation/deploy operation on
 * that same server name for minutes. This wraps every doctor-issued
 * `transport.exec()` call in an explicit `Promise.race` against a short
 * timer — a minimal, doctor-local guard (no change to `IServerTransport` or
 * any transport implementation). A timeout is surfaced as a rejected
 * promise so every existing call site's `catch (err) { ... unknown ... }`
 * handles it exactly like any other unreachable-transport error, matching
 * this module's fail-closed contract (an unproven check is `'unknown'`,
 * never `'pass'`).
 */
const DOCTOR_PROBE_TIMEOUT_MS = 20_000;

async function execProbe(
  transport: IServerTransport,
  command: string,
  timeoutMs = DOCTOR_PROBE_TIMEOUT_MS,
): Promise<ReturnType<IServerTransport['exec']> extends Promise<infer R> ? R : never> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`probe timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([transport.exec(command, timeoutMs), timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Review round (Important finding 1, isolation doctor doc レビュー): a
 * non-zero exit from a probe command must NEVER surface `stdout`/`stderr`
 * verbatim into a persisted `detail` — this doctor's own probes read
 * `settings.json`/`config.toml`/`operator.env`/azitoctl*.env content
 * (base64-framed) in the SAME command batch that can fail non-zero for an
 * unrelated reason (timeout, buffer overflow, one entry in a batch tripping
 * an error after a prior entry's content was already echoed), so raw
 * stdout/stderr is not "diagnostic noise" here — it can BE the secret this
 * doctor exists to detect. `detail` is written to `isolation_report`,
 * relayed through the audit log, and rendered in the browser (routes.ts's
 * POST .../isolation/doctor, OverviewSection.tsx), so redaction must happen
 * at the source, not only at the routes-layer `redactSecrets` last line of
 * defense. Every non-zero-exit branch in this file reports ONLY the exit
 * code and a fixed, code-controlled label — never any captured output.
 */
function execFailureDetail(label: string, code: number): string {
  return `${label} (exit ${code})`;
}

/**
 * Same redaction contract as `execFailureDetail`, for the "output parsed but
 * didn't match any recognized shape" branches: these still hold raw
 * stdout at the call site (it just failed to match expected markers), so
 * the caller must never interpolate it into `detail` either — see
 * `execFailureDetail`'s doc comment.
 */
function unrecognizedOutputDetail(label: string): string {
  return `${label}（想定外の形式）`;
}

// ─── Framed file probing (review round, Critical finding 2 / follow-up
// review round, Important finding 3) ───
//
// The previous implementation searched raw shell stdout for bare marker
// strings like `AZT_FILE_BEGIN` and treated a hit/miss as the file's
// presence/absence, then sliced "content" out from between two such
// markers found via `indexOf`. Any probed file that happened to CONTAIN one
// of those literal marker strings (a settings.json/config.toml with a
// comment or string value quoting them, however unlikely) would corrupt the
// parse silently — content search offset by an in-band collision, or a
// begin/end pair matched against the wrong occurrence. This reimplementation
// never searches file CONTENT for markers: presence/absence and the content
// itself travel on separate, clearly delimited lines (`AZT_STATUS:<key>:...`),
// the content itself is base64-encoded so it cannot contain a literal
// newline (or anything else) that could be mistaken for a status line.
//
// Follow-up review round, Important finding 3: the FIRST version of this
// framing unconditionally echoed `present`/`AZT_STATUS_END` around the
// `base64` invocation regardless of whether `base64` itself succeeded — a
// missing `base64` binary, a permission error surviving past the `[ -f ]`
// test (e.g. a TOCTOU unlink, or a file readable by `stat` but not by the
// probing user), or any other encode failure would silently degrade to an
// EMPTY content frame, and `probeFilesFramed` treated that indistinguishably
// from a genuinely empty file (`{ kind: 'content', content: '' }`) — a
// silent, wrong pass for checks like `checkNoOperatorToken` that only fail
// when specific text is FOUND in the content (empty content always looks
// clean). The command now branches on `base64`'s own exit status via
// `B64=$(base64 < path 2>/dev/null)`: only a genuinely successful encode
// emits the `present`/content/`AZT_STATUS_END` frame; a failed encode emits
// a distinct `unreadable` status with no content frame at all, and the
// content that IS returned is additionally validated as syntactically valid
// base64 (charset + padding + round-trip) before being decoded — anything
// that fails validation, or that doesn't fit one of the three recognized
// status literals, is `'unrecognized'`. Both `'unreadable'` and
// `'unrecognized'` fold to the doctor's `'unknown'` in every caller below —
// never silently read as "empty" or "absent".
export type FileProbeOutcome =
  | { kind: 'absent' }
  | { kind: 'content'; content: string }
  | { kind: 'unreadable' }
  | { kind: 'unrecognized' };

const BASE64_STRICT_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Strictly validates that `b64` is syntactically valid base64 (charset,
 * padding, length%4) AND round-trips (re-encoding the decoded bytes
 * reproduces the same string) before decoding it. `Buffer.from(x, 'base64')`
 * does NOT throw on malformed input — it silently drops invalid characters —
 * so without this check a corrupted/truncated transport stream could decode
 * to arbitrary wrong bytes and still report `kind: 'content'`. Returns
 * `null` (never a best-effort decode) on any mismatch.
 */
function decodeStrictBase64(b64: string): string | null {
  if (b64.length % 4 !== 0 || !BASE64_STRICT_RE.test(b64)) return null;
  const buf = Buffer.from(b64, 'base64');
  if (buf.toString('base64') !== b64) return null;
  return buf.toString('utf-8');
}

/**
 * Probes one or more files in a single round-trip. `entries[].pathExpr` must
 * already be valid, safely-quoted shell syntax as it will be embedded
 * VERBATIM into the command line — callers pass either a literal
 * double-quoted string containing only hub-controlled shell variables (e.g.
 * `"$HOME/.claude/settings.json"`, no injection surface since nothing
 * attacker-influenced reaches it) or `shellQuote(...)` of a fully-resolved
 * path when any component (e.g. a filename discovered via a prior `ls`) is
 * remote/attacker-influenced. `entries[].key` must be a fixed, code-controlled
 * identifier (never remote data) — it is embedded directly into the framing
 * markers this function parses back out.
 */
export async function probeFilesFramed(
  transport: IServerTransport,
  entries: { key: string; pathExpr: string }[],
): Promise<{ ok: true; results: Map<string, FileProbeOutcome> } | { ok: false; detail: string }> {
  if (entries.length === 0) return { ok: true, results: new Map() };
  // Follow-up review round, Important finding 3: `base64`'s own exit status
  // (captured via `B64=$(...)`) gates which status literal gets echoed — the
  // `present`/content/`AZT_STATUS_END` frame is emitted ONLY when the encode
  // itself succeeded, never unconditionally around it. A failed encode
  // (missing `base64`, a TOCTOU permission error after the `[ -f ]` test,
  // etc.) reports the distinct `unreadable` status with no content frame at
  // all, instead of degrading to an indistinguishable empty-content frame.
  const cmd = entries
    .map(({ key, pathExpr }) =>
      `if [ -f ${pathExpr} ]; then if B64=$(base64 < ${pathExpr} 2>/dev/null); then echo "AZT_STATUS:${key}:present"; printf '%s\\n' "$B64"; echo "AZT_STATUS_END:${key}"; else echo "AZT_STATUS:${key}:unreadable"; fi; else echo "AZT_STATUS:${key}:absent"; fi`)
    .join('; ');
  let result;
  try {
    result = await execProbe(transport, cmd);
  } catch (err) {
    return { ok: false, detail: `ファイルの取得に失敗しました（到達不能）: ${errMsg(err)}` };
  }
  if (result.code !== 0) {
    return { ok: false, detail: execFailureDetail('ファイルの取得に失敗しました', result.code) };
  }
  const lines = result.stdout.split('\n');
  const results = new Map<string, FileProbeOutcome>();
  for (const { key } of entries) {
    const presentIdx = lines.findIndex((l) => l.trim() === `AZT_STATUS:${key}:present`);
    const absentIdx = lines.findIndex((l) => l.trim() === `AZT_STATUS:${key}:absent`);
    const unreadableIdx = lines.findIndex((l) => l.trim() === `AZT_STATUS:${key}:unreadable`);
    if (presentIdx === -1) {
      if (absentIdx !== -1) results.set(key, { kind: 'absent' });
      else if (unreadableIdx !== -1) results.set(key, { kind: 'unreadable' });
      else results.set(key, { kind: 'unrecognized' });
      continue;
    }
    const endIdx = lines.findIndex((l, i) => i > presentIdx && l.trim() === `AZT_STATUS_END:${key}`);
    if (endIdx === -1) {
      results.set(key, { kind: 'unrecognized' });
      continue;
    }
    const b64 = lines.slice(presentIdx + 1, endIdx).join('').trim();
    const decoded = decodeStrictBase64(b64);
    if (decoded === null) {
      // Malformed/corrupted base64 is never treated as "empty content" —
      // ambiguous is unrecognized (folds to 'unknown' in every caller).
      results.set(key, { kind: 'unrecognized' });
      continue;
    }
    results.set(key, { kind: 'content', content: decoded });
  }
  return { ok: true, results };
}

/** Single-file convenience wrapper over probeFilesFramed. */
async function probeFile(transport: IServerTransport, pathExpr: string): Promise<{ ok: true; probe: FileProbeOutcome } | { ok: false; detail: string }> {
  const batch = await probeFilesFramed(transport, [{ key: 'f', pathExpr }]);
  if (!batch.ok) return batch;
  return { ok: true, probe: batch.results.get('f') ?? { kind: 'unrecognized' } };
}

// Strict RFC-4122-shaped UUID matcher for `/proc/sys/kernel/random/boot_id`.
// Review round (Nit, same_host judgment restructure): the prior loose
// `/^[0-9a-fA-F-]{8,}$/` accepted degenerate values like `11111111` or
// `--------` — neither is a real boot id, so treating either as "obtained"
// would let a garbled/truncated read masquerade as a valid comparison
// input. Anything that doesn't fit this shape is treated as "could not be
// obtained", exactly like a read failure. Applied to BOTH the hub side and
// the remote side before they are ever compared.
const STRICT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validates and lower-cases a boot_id candidate; returns `null` (never a
 * best-effort passthrough) for anything not shaped like a UUID. */
function normalizeBootId(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  return STRICT_UUID_RE.test(trimmed) ? trimmed.toLowerCase() : null;
}

/**
 * 1. Same-host / FS-boundary detection.
 *
 * Review round (same_host judgment restructure — the prior boot_id-primary
 * version had three problems, fixed here):
 *
 *  - boot_id CAN be virtualized per-container (systemd-nspawn / LXC can each
 *    report a different value on the same physical host), so a MISMATCH is
 *    not proof of separation — treating it as decisive `'pass'` evidence (as
 *    the prior version did) was wrong.
 *  - the prior version folded a canary-measurement failure into
 *    `canaryReadable = false`, i.e. indistinguishable from a genuinely
 *    absent canary — an unmeasurable canary could reach `'pass'` via the
 *    boot_id-mismatch branch, silently regressing the rotation-race defense
 *    this check used to have.
 *  - on a darwin/macOS hub (a build target this project ships), `bootId` is
 *    always `null` — the prior version's non-Linux fallback (hostname/uid)
 *    can only reach `'fail'`/`'unknown'`, never `'pass'`, so a macOS hub
 *    could never verify an agent server at all.
 *
 * The canary probe (an actual, measured FS-reachability test) is restored as
 * the ONLY path to `'pass'`; boot_id is demoted to a same-kernel signal that
 * can only strengthen `'fail'` (a MATCH still proves a shared kernel — a
 * container cannot fake reporting a different kernel's id, only spoof its
 * own value — so it is trustworthy in that one direction). Judgment order:
 *
 *  1. canary read back with matching content → `'fail'` (positive proof of a
 *     shared filesystem).
 *  2. both hub and target boot_id were obtained (strict UUID shape on both
 *     sides — see `normalizeBootId`) AND equal → `'fail'` (same kernel =
 *     same host; catches the chroot/container case hostname/uid alone
 *     misses). A mismatch here decides nothing by itself — it is NOT used to
 *     reach `'pass'`.
 *  3. the canary probe completed with a genuine `absent` result AND the
 *     hub's own canary is confirmed still intact on disk RIGHT NOW (see
 *     `isCanaryStillIntact` — guards against the local canary rotating out
 *     from under an in-flight probe, which would make a same-filesystem
 *     target's "absent" answer indistinguishable from a truly isolated
 *     one's) → `'pass'`. boot_id's availability is irrelevant to this
 *     branch — a macOS hub (`bootId: null`) reaches `'pass'` here exactly
 *     like a Linux one, since the canary is the actual measurement.
 *  4. hostname AND uid both match → `'fail'` (a strong same-host hint — a FALLBACK, consulted
 *     only in the fail direction, same reasoning as boot_id).
 *     ONLY when the canary could not be measured: hostname reuse across
 *     separate machines is legal and uid 1000 is the near-universal
 *     default, so this coincidence must never override a trustworthy
 *     canary measurement above.
 *  5. anything else (canary unmeasurable — no hub canary, probe
 *     unreachable/timed out, an `'unreadable'`/`'unrecognized'` outcome, or
 *     `'content'` that didn't match; a rotation race caught by step 4's
 *     intactness check; boot_id/hostname/uid that didn't reach a `'fail'`
 *     branch) → `'unknown'`.
 *
 * `detail` always names which branch decided the check, but NEVER includes
 * either side's raw boot_id value (`detail` is persisted to
 * `isolation_report` and the audit log) — only the fact that it matched or
 * did not.
 *
 * Doctrine (ties into the module top-of-file doctrine comment): a `'pass'`
 * here is evidence that this probe could not reach the hub's data
 * directory — it is NOT proof of running on a separate physical/virtual
 * host. A container sharing the hub's kernel but given its own filesystem
 * namespace (and a virtualized boot_id) can reach `'pass'` legitimately,
 * because the property this doctor actually cares about — layer 2's "no
 * credential is handed to a principal that can read the hub's data" — still
 * holds in that configuration even though it is not a different host. An
 * adversarial target can still self-report false answers to every probe in
 * this module; that gap is the ratified doctrine's concern, not something
 * this individual check can close.
 *
 * Out of scope: a bind-mount of the hub's data directory at a DIFFERENT path
 * on the target (so the canary's exact path probe misses it) is not
 * detected by this check — an accepted limit of the misconfiguration-detector
 * doctrine, not a defect to re-litigate here.
 */
async function checkFsAndHostBoundary(transport: IServerTransport, hub: HubIdentity): Promise<IsolationCheck> {
  const id = 'same_host';
  let hostResult;
  try {
    hostResult = await execProbe(transport, 'hostname; id -u');
  } catch (err) {
    return { id, status: 'unknown', detail: `hostname/uid の取得に失敗しました（到達不能）: ${errMsg(err)}` };
  }
  if (hostResult.code !== 0) {
    return { id, status: 'unknown', detail: execFailureDetail('hostname/uid の取得に失敗しました', hostResult.code) };
  }
  const lines = hostResult.stdout.split('\n').map((l) => l.trim());
  const remoteHostname = lines[0] ?? '';
  const remoteUidStr = lines[1] ?? '';
  const remoteUid = /^\d+$/.test(remoteUidStr) ? Number(remoteUidStr) : null;
  if (!remoteHostname || remoteUid === null) {
    return { id, status: 'unknown', detail: unrecognizedOutputDetail('hostname/uid の出力を解析できませんでした') };
  }
  if (hub.uid === null) {
    return { id, status: 'unknown', detail: 'ハブ側の uid を取得できなかったため、同一ホスト判定ができません（process.getuid が利用不可）' };
  }
  const sameHostname = remoteHostname === hub.hostname;
  const sameUid = remoteUid === hub.uid;
  const identity = `agent: ${remoteHostname}/${remoteUid}、hub: ${hub.hostname}/${hub.uid}`;

  // Actual FS-reachability measurement — null means "could not be measured
  // this round" (no canary to test, transport unreachable, or an
  // unrecognized probe result), which must never be folded into a pass.
  let canaryReadable: boolean | null = null;
  // Distinguishes "the remote probe itself never completed" (handled by
  // canaryReadable staying null below) from "the remote probe DID complete
  // with a clean 'absent' answer, but the local canary rotated out from
  // under it during that round-trip" — the latter needs its own detail text
  // since it is a positive detection of a race, not a generic unmeasured
  // state.
  let canaryRotatedDuringProbe = false;
  if (hub.canary) {
    const probed = await probeFilesFramed(transport, [{ key: 'canary', pathExpr: shellQuote(hub.canary.path) }]);
    if (probed.ok) {
      const outcome = probed.results.get('canary');
      if (outcome?.kind === 'content' && outcome.content === hub.canary.content) {
        canaryReadable = true;
      } else if (outcome?.kind === 'absent') {
        // A remote "absent" is only trustworthy as proof of separation if
        // the exact canary (same path, same content) this probe was sent
        // for is STILL intact on the hub's own disk right now. If it
        // changed or vanished mid-flight (a concurrent regeneration/
        // rotation), a same-filesystem target reading the now-stale path
        // would ALSO see "absent" and be indistinguishable from a genuinely
        // isolated one — so this round's remote answer no longer proves
        // anything. Deliberately no retry: degrades straight to 'unknown'
        // rather than attempting a second round-trip against a possibly
        // still-unstable canary.
        if (isCanaryStillIntact(hub.canary)) {
          canaryReadable = false;
        } else {
          canaryRotatedDuringProbe = true;
        }
      }
      // 'unreadable', 'unrecognized', or 'content' with unexpected bytes:
      // canaryReadable stays null (unmeasured).
    }
  }

  if (canaryReadable) {
    return {
      id,
      status: 'fail',
      detail: `agent サーバーからハブのデータディレクトリ内のカナリアファイルが読み取れました（同一ファイルシステムを共有しています）: ${hub.canary!.path}`,
    };
  }

  const bootProbed = await probeFile(transport, '/proc/sys/kernel/random/boot_id');
  const remoteBootIdValue = bootProbed.ok && bootProbed.probe.kind === 'content'
    ? normalizeBootId(bootProbed.probe.content)
    : null;
  const hubBootIdValue = normalizeBootId(hub.bootId);

  if (remoteBootIdValue && hubBootIdValue && remoteBootIdValue === hubBootIdValue) {
    return {
      id,
      status: 'fail',
      detail: `boot_id（カーネルの起動ID）が一致しました — 同一カーネルを共有しているため同一ホストと判定します。${identity}`,
    };
  }

  if (canaryReadable === false) {
    return {
      id,
      status: 'pass',
      detail: `agent サーバーからハブのデータディレクトリ内のカナリアファイルを読み取れませんでした（不在）— ハブのデータに到達できないため別ファイルシステムと判定します。プローブ往復後もハブ側のカナリアは健在で、ローテーション競合の影響も受けていません。${identity}`,
    };
  }

  // hostname/uid はカナリアが測定できなかった場合の補助的な手掛かりに留める
  // （レビュー指摘）: hostname の再利用は別マシン間でも起こり得るし uid 1000 は
  // ほぼ全ての Linux で既定値。直接の実測であるカナリアが「到達不能」を信頼できる
  // 形で示している場合、その弱い識別子の偶然の一致で棄却してはならない。
  if (sameHostname && sameUid) {
    return {
      id,
      status: 'fail',
      detail: `hostname と uid が両方とも一致しました — 同一ホストの強い示唆として判定します。${identity}`,
    };
  }

  if (canaryRotatedDuringProbe) {
    return {
      id,
      status: 'unknown',
      detail: `カナリアファイルがプローブの往復中にローテーション/削除されたため、リモートの「不在」応答を信頼できませんでした。${identity}（設定ミス検出としての判定であり、敵対的ホストは自己申告を偽装しうる — モジュール冒頭のドクトリンを参照）`,
    };
  }

  return {
    id,
    status: 'unknown',
    detail: hub.canary
      ? `ファイルシステム分離を実測できませんでした（カナリアファイルの読み取り結果が不明でした）。${identity}（設定ミス検出としての判定であり、敵対的ホストは自己申告を偽装しうる — モジュール冒頭のドクトリンを参照）`
      : `ハブ側にカナリアファイルが存在しないため、ファイルシステム分離を実測できませんでした（ハブ起動時の書き込みに失敗した可能性があります）。${identity}`,
  };
}

/**
 * 2. `~/.ssh` に秘密鍵が無い — `PRIVATE KEY` ヘッダ走査。ディレクトリ自体が
 * 存在しない場合は自明に pass（走査対象がない）。
 *
 * Review round (Important finding 2): the previous command echoed a
 * terminator (`AZT_SSH_DIR_EXISTS`) unconditionally AFTER `grep`, discarding
 * `grep`'s own exit status — a `grep` that failed outright (binary missing
 * from PATH, a scan error on an unreadable subentry, anything other than a
 * clean "ran and found nothing") produced empty stdout indistinguishable
 * from "ran cleanly and found no private keys", silently reporting `'pass'`
 * for a scan that never actually happened. `grep`'s own `$?` is now
 * captured and reported as an explicit `AZT_GREP_STATUS:<n>` line: exit 0
 * (matches found) -> `'fail'`, exit 1 (ran cleanly, no matches) -> `'pass'`,
 * any other exit code (2+: usage/read error) -> `'unknown'`. `grep` itself
 * being absent from PATH is also its own explicit `unknown`, never folded
 * into "no matches".
 *
 * Scope note: this scan only covers PEM-style headers (`PRIVATE KEY`) under
 * `~/.ssh`. PuTTY's `.ppk` format and keys stored outside `~/.ssh` are not
 * scanned — a known limitation of a misconfiguration detector, not a
 * completeness guarantee (see the module-level doctrine comment).
 */
async function checkNoPrivateKeys(transport: IServerTransport): Promise<IsolationCheck> {
  const id = 'no_ssh_private_keys';
  // Review round (Issue #29 5th pass, Important finding 3): `-r` does not
  // follow symlinks it encounters WITHIN the scanned directory (a common
  // real layout: `~/.ssh/id_ed25519 -> /path/to/actual/key`), so a private
  // key reachable only through a symlink was silently invisible to this
  // scan. `-R` (--dereference-recursive) follows those symlinks; a broken
  // link or a permission error on the link target still folds into grep's
  // own non-zero-but-not-2 exit classification below (unknown), not a
  // silent skip.
  const cmd = 'if [ -d "$HOME/.ssh" ]; then '
    + 'if command -v grep >/dev/null 2>&1; then '
    + 'OUT=$(grep -RIl "PRIVATE KEY" "$HOME/.ssh" 2>/dev/null); GREP_STATUS=$?; '
    + 'echo "AZT_GREP_STATUS:$GREP_STATUS"; '
    + 'printf \'%s\\n\' "$OUT"; '
    + 'echo AZT_SSH_DIR_EXISTS; '
    + 'else echo AZT_GREP_ABSENT; fi; '
    + 'else echo AZT_SSH_NO_DIR; fi';
  let result;
  try {
    result = await execProbe(transport, cmd);
  } catch (err) {
    return { id, status: 'unknown', detail: `~/.ssh の走査に失敗しました（到達不能）: ${errMsg(err)}` };
  }
  if (result.code !== 0) {
    return { id, status: 'unknown', detail: execFailureDetail('~/.ssh の走査に失敗しました', result.code) };
  }
  const lines = result.stdout.split('\n').map((l) => l.trim());
  const trimmedNonEmpty = lines.filter(Boolean);
  if (trimmedNonEmpty.includes('AZT_SSH_NO_DIR')) {
    return { id, status: 'pass', detail: '~/.ssh ディレクトリが存在しません' };
  }
  if (trimmedNonEmpty.includes('AZT_GREP_ABSENT')) {
    return { id, status: 'unknown', detail: 'grep コマンドが見つからないため、~/.ssh の秘密鍵走査ができませんでした' };
  }
  const statusIdx = lines.findIndex((l) => /^AZT_GREP_STATUS:-?\d+$/.test(l));
  const endIdx = lines.findIndex((l) => l === 'AZT_SSH_DIR_EXISTS');
  if (statusIdx === -1 || endIdx === -1 || endIdx <= statusIdx) {
    return { id, status: 'unknown', detail: unrecognizedOutputDetail('~/.ssh の走査結果を解析できませんでした') };
  }
  const grepStatus = Number(lines[statusIdx].slice('AZT_GREP_STATUS:'.length));
  const offenders = lines.slice(statusIdx + 1, endIdx).filter(Boolean);
  if (grepStatus === 0) {
    if (offenders.length === 0) {
      // grep reported a match (exit 0) but no filename made it through —
      // an internal inconsistency this doctor must not paper over as clean.
      return { id, status: 'unknown', detail: 'grep が一致を報告しましたが、対象ファイル名を取得できませんでした' };
    }
    return { id, status: 'fail', detail: `秘密鍵らしきファイルが見つかりました: ${offenders.join(', ')}` };
  }
  if (grepStatus === 1) {
    return { id, status: 'pass', detail: '~/.ssh 配下に秘密鍵は見つかりませんでした' };
  }
  return { id, status: 'unknown', detail: `grep の走査が異常終了しました (exit ${grepStatus})` };
}

/**
 * Conservative, non-YAML-library extraction of `gh`'s `hosts.yml` top-level
 * keys (each key is a hostname `gh` is authenticated against). Deliberately
 * NOT a general YAML parser — `gh`'s own hosts.yml shape is always a flat
 * mapping of `hostname:` at column 0 with everything else (oauth_token,
 * user, git_protocol, ...) indented underneath, so a line-based rule
 * ("no leading whitespace, not a comment, ends in `key:` with nothing but
 * an optional trailing comment") is sufficient and avoids pulling in a YAML
 * dependency for a single-purpose, adversarial-input-adjacent parse. Any
 * line that doesn't fit this shape is simply not counted as a host — see
 * `checkGhUnauthenticated`'s caller-side handling of "zero keys extracted"
 * for how that ambiguity is NOT silently treated as "no other hosts".
 */
function parseGhHostsYamlKeys(content: string): string[] {
  const keys: string[] = [];
  for (const rawLine of content.split('\n')) {
    if (/^\s/.test(rawLine)) continue; // indented -> nested value, not a top-level host key
    const line = rawLine.trimEnd();
    if (line === '' || line.startsWith('#')) continue;
    const m = /^([^\s:#][^:#]*):\s*(#.*)?$/.exec(line);
    if (m) keys.push(m[1]);
  }
  return keys;
}

/**
 * 3. gh にローカル資格情報（保存済みトークン）が残っていない。
 *
 * Review round (Important finding 3): `gh auth status` はネットワーク到達性
 * や API 応答も判定に含む複合コマンドで、GitHub 側の一時的な不達や設定読取
 * 失敗など「ローカルにトークンは残っているが確認コマンド自体が失敗した」
 * ケースを未認証（`'pass'`）に丸めてしまっていた。判定対象をローカル資格情報
 * の有無だけに絞るため `gh auth token >/dev/null 2>&1` の exit code を見る
 * （値そのものは決して出力させない — stdout は破棄）。
 *
 * Follow-up review round (Important finding 2): `gh auth token` with no
 * `--hostname` only ever resolves the DEFAULT host (`github.com`, or a repo
 * host inferred from cwd) — a token stored against a second host (GitHub
 * Enterprise, a self-hosted instance) was invisible to the old single-shot
 * check even though `gh` could still use it to authenticate against that
 * host. This now enumerates every host `gh` has ever logged into by reading
 * its `hosts.yml` (honoring `$GH_CONFIG_DIR`, `gh`'s own override for where
 * that file lives) and probes `gh auth token --hostname <host>` against
 * EACH ONE — any single host succeeding is a `'fail'`, matching the
 * fail-closed contract (one reachable credential is enough).
 *
 * Host enumeration:
 *  - `hosts.yml` absent → the default host (`github.com`) alone is checked
 *    (nothing else to enumerate; a legitimate `'pass'` path per this
 *    review's own guidance).
 *  - `hosts.yml` present and readable → parsed via `parseGhHostsYamlKeys`
 *    (conservative top-level-key extraction, see its doc comment) and
 *    merged with `github.com` (always checked as a baseline regardless of
 *    what the file does or doesn't mention).
 *  - `hosts.yml` present but unreadable/unrecognized (the framed probe
 *    could not confirm its content) → `'unknown'` for the WHOLE check —
 *    enumeration that might be incomplete must never silently degrade to
 *    "check the default host only", per this finding's own fail-closed
 *    requirement.
 *
 * `GH_TOKEN`/`GITHUB_TOKEN`/`GH_ENTERPRISE_TOKEN`/`GITHUB_ENTERPRISE_TOKEN`
 * (review round, same finding; Enterprise variants added in a later review
 * round): `gh` itself reads all four environment variables as authentication
 * overrides, bypassing `hosts.yml`/`gh auth token` entirely, and (unlike
 * `AZITO_AGENT_TOKEN`) none is a transport credential this doctor must
 * tolerate — their mere PRESENCE (never the value; same `${VAR+x}`
 * existence-only technique as `checkNoOperatorEnvironment`) is enough to fail
 * this check, independent of the per-host `gh auth token` results and even
 * when `gh` itself is absent (some other tool, or a `gh` installed later,
 * could still consume them). The Enterprise pair matters specifically
 * because host enumeration (above) only walks `hosts.yml` — when that file
 * is absent, only `github.com` is probed via `gh auth token`, so a Enterprise
 * token supplied purely via environment (never written to `hosts.yml`) would
 * otherwise be invisible to every check in this function.
 *
 * exit code 分類 (per host):
 *  - exit 0（トークン取得成功 = そのホストにローカル資格情報が存在する）→ `'fail'`
 *  - exit 1（gh 自身の「そのホストにログインしていません」規約上の失敗）→ pass 方向
 *  - それ以外の exit code（usage エラー等、判別不能な異常）→ `'unknown'`
 *  - `gh` コマンド自体が不在 → ホスト単位チェック（`gh auth token`）はスキップ
 *
 * Review round (Important finding 1): `gh` が PATH に無い場合、上記のホスト単位
 * チェックが丸ごとスキップされ、環境変数も未設定なら `'pass'` になっていた。だが
 * Linux のヘッドレス環境（OS キーリングが使えない）では `gh` はログイン時に
 * `hosts.yml` へ `oauth_token:` を**平文で**書き込む。「`gh` を後から削除したが
 * `hosts.yml` は残っている」という設定ミスは、ディスク上に読める資格情報がある
 * のに `gh` がいないという理由だけで検査対象から外れてしまう — これは「`gh` の
 * 有無」ではなく「資格情報が残っているか」を見るべき検査の趣旨に反する。そのため
 * `gh` 不在の場合でも、Step 1 で既に読み取り済みの `hosts.yml` の内容
 * （`hostsProbe.kind === 'content'`）に対し、ホストキー配下のインデント行に
 * `oauth_token:` キーが見つかれば `'fail'` とする（値・対応するホスト名は出さず、
 * 固定文言のみを detail に載せる。ホスト名の列挙自体は非秘匿情報なので許容する）。
 * `hosts.yml` が不在（`hostsProbe.kind === 'absent'`）なら、そもそも `gh` が
 * 一度もログインしたことがないので従来どおり pass 方向。`hosts.yml` が
 * unreadable/unrecognized の場合は Step 1 で既に `'unknown'` を返しており、
 * この分岐には到達しない。
 *
 * 補助線としての限界: OS キーリング（macOS Keychain 等）が有効な環境では `gh`
 * はトークンをキーリングへ保存し、`hosts.yml` には現れない。この `hosts.yml`
 * 走査はあくまで「平文ファイルが残っていないか」を見る補助的な検査であり、本線は
 * （`gh` が存在する環境での）`gh auth token` 経由の照会である。
 */
async function checkGhUnauthenticated(transport: IServerTransport): Promise<IsolationCheck> {
  const id = 'gh_unauthenticated';

  // Step 1: enumerate hosts via hosts.yml (env-token existence is checked
  // together with the host probes below, in the same round-trip).
  const hostsFileProbe = await probeFile(
    transport,
    '"${GH_CONFIG_DIR:-$HOME/.config/gh}/hosts.yml"',
  );
  if (!hostsFileProbe.ok) {
    return { id, status: 'unknown', detail: `gh hosts.yml の${hostsFileProbe.detail}` };
  }
  const { probe: hostsProbe } = hostsFileProbe;
  let hosts: string[];
  if (hostsProbe.kind === 'absent') {
    hosts = ['github.com'];
  } else if (hostsProbe.kind === 'content') {
    const parsed = parseGhHostsYamlKeys(hostsProbe.content);
    // Review round (Issue #29 5th pass, Important finding 2): a top-level
    // key extraction succeeding is not, by itself, proof the file's NESTED
    // structure was read correctly — `gh`'s hosts.yml always indents every
    // value (oauth_token, user, ...) under its host key, so a genuine
    // hosts.yml with at least one host has at least one indented line.
    // Content that has ≥1 top-level key but ZERO indented lines anywhere is
    // a shape this doctor cannot explain (truncated content, a hosts.yml
    // rewritten with unconventional formatting, transport corruption) —
    // treat enumeration as unreliable rather than trust the possibly-partial
    // key list. Chosen conservatively (any indented line anywhere counts,
    // not tied to a specific host key) to minimize false 'unknown's on
    // legitimate hosts.yml files while still catching the "we clearly
    // didn't parse the nesting" case.
    const hasIndentedLine = hostsProbe.content.split('\n').some((l) => /^[ \t]+\S/.test(l));
    if (parsed.length > 0 && !hasIndentedLine) {
      return {
        id,
        status: 'unknown',
        detail: 'gh hosts.yml のネスト構造を読み取れなかったため（ホストキー行以外にインデント行が見つかりません）、認証済みホストを列挙できませんでした',
      };
    }
    hosts = Array.from(new Set(['github.com', ...parsed]));
  } else {
    // 'unreadable' | 'unrecognized': the file exists but its content could
    // not be confirmed, so the host list may be incomplete — checking only
    // the default host here would be an unenumerated-scope fail-open.
    return { id, status: 'unknown', detail: 'gh hosts.yml の内容を確認できなかったため、認証済みホストを列挙できませんでした' };
  }

  // Step 2: probe every enumerated host's local token in one round-trip,
  // plus GH_TOKEN/GITHUB_TOKEN/GH_ENTERPRISE_TOKEN/GITHUB_ENTERPRISE_TOKEN existence (never their value).
  const hostChecks = hosts
    .map((h, i) => `if command -v gh >/dev/null 2>&1; then gh auth token --hostname ${shellQuote(h)} >/dev/null 2>&1; echo "AZT_GH_HOST_EXIT:${i}:$?"; else echo AZT_GH_ABSENT; fi`)
    .join('; ');
  const cmd = `${hostChecks}; `
    + '[ -n "${GH_TOKEN+x}" ] && echo AZT_GH_TOKEN_ENV_PRESENT; '
    + '[ -n "${GITHUB_TOKEN+x}" ] && echo AZT_GITHUB_TOKEN_ENV_PRESENT; '
    + '[ -n "${GH_ENTERPRISE_TOKEN+x}" ] && echo AZT_GH_ENTERPRISE_TOKEN_ENV_PRESENT; '
    + '[ -n "${GITHUB_ENTERPRISE_TOKEN+x}" ] && echo AZT_GITHUB_ENTERPRISE_TOKEN_ENV_PRESENT; '
    + 'echo AZT_GH_CHECK_DONE';
  let result;
  try {
    result = await execProbe(transport, cmd);
  } catch (err) {
    return { id, status: 'unknown', detail: `gh の確認に失敗しました（到達不能）: ${errMsg(err)}` };
  }
  if (result.code !== 0) {
    return { id, status: 'unknown', detail: execFailureDetail('gh の確認に失敗しました', result.code) };
  }
  const lines = result.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.includes('AZT_GH_CHECK_DONE')) {
    return { id, status: 'unknown', detail: unrecognizedOutputDetail('gh の確認結果を解析できませんでした') };
  }
  const ghAbsent = lines.includes('AZT_GH_ABSENT');
  const envTokenPresent = lines.includes('AZT_GH_TOKEN_ENV_PRESENT')
    || lines.includes('AZT_GITHUB_TOKEN_ENV_PRESENT')
    || lines.includes('AZT_GH_ENTERPRISE_TOKEN_ENV_PRESENT')
    || lines.includes('AZT_GITHUB_ENTERPRISE_TOKEN_ENV_PRESENT');

  let anyFail = false;
  let anyUnknown = false;
  if (!ghAbsent) {
    for (let i = 0; i < hosts.length; i++) {
      const line = lines.find((l) => l.startsWith(`AZT_GH_HOST_EXIT:${i}:`));
      if (!line) {
        anyUnknown = true;
        continue;
      }
      const exitCode = Number(line.slice(`AZT_GH_HOST_EXIT:${i}:`.length));
      if (!Number.isFinite(exitCode)) {
        anyUnknown = true;
      } else if (exitCode === 0) {
        anyFail = true;
      } else if (exitCode !== 1) {
        anyUnknown = true;
      }
    }
  }

  // Review round (Important finding 1): gh 不在でも hosts.yml に平文トークンが
  // 残っていれば fail とする（see the doc comment above the function for the
  // full rationale and the "OS keyring は補助線" caveat).
  const hostsFileHasPlaintextToken = ghAbsent
    && hostsProbe.kind === 'content'
    && hostsProbe.content.split('\n').some((l) => /^[ \t]+oauth_token\s*:/.test(l));

  if (anyFail || envTokenPresent || hostsFileHasPlaintextToken) {
    const reasons: string[] = [];
    if (anyFail) reasons.push('少なくとも1つのホストで gh にローカル資格情報（トークン）が残っています');
    if (envTokenPresent) reasons.push('GH_TOKEN/GITHUB_TOKEN/GH_ENTERPRISE_TOKEN/GITHUB_ENTERPRISE_TOKEN のいずれかの環境変数が設定されています（値は表示しません）');
    if (hostsFileHasPlaintextToken) reasons.push('gh コマンドは見つかりませんが、hosts.yml に保存済みトークンがあります');
    return { id, status: 'fail', detail: reasons.join(' / ') };
  }
  if (anyUnknown) {
    return { id, status: 'unknown', detail: 'gh auth token が一部のホストで判別不能な結果を返しました — ローカル資格情報の有無を確定できません' };
  }
  return {
    id,
    status: 'pass',
    detail: ghAbsent
      ? 'gh コマンドが見つかりません（GH_TOKEN/GITHUB_TOKEN/GH_ENTERPRISE_TOKEN/GITHUB_ENTERPRISE_TOKEN も未設定、hosts.yml にも保存済みトークンはありません）'
      : `gh にローカル資格情報はありません（確認したホスト: ${hosts.join(', ')}）`,
  };
}

/**
 * 4. git credential helper が空・`~/.git-credentials` が不在。
 *
 * Review round (Important finding 2): `git config --global --get
 * credential.helper` 自身の exit status を捨てて stdout だけを見ていたため、
 * git 自体が不在、または設定ファイル読取エラー（壊れた `.gitconfig` 等）で
 * コマンドが失敗した場合も stdout が空になり「未設定」と区別が付かず、真の
 * 未設定と同じ `'pass'` 方向に丸め込まれていた。`git config --get` の exit
 * code を明示的に捕捉して分類する: 0（設定あり）→ 既存の分類へ、1（キーが
 * 存在しない = 真に未設定）→ pass 方向、それ以外（2+: 構文エラー等）または
 * git コマンド自体が不在 → `'unknown'`。
 *
 * Follow-up review round (Important finding): `--global` scope alone misses
 * a helper set via `/etc/gitconfig` (system scope) or `GIT_CONFIG_SYSTEM`
 * — a real, honest misconfiguration this doctor exists to catch, not just an
 * adversarial-host concern. Switched to `git config --show-origin --get-all
 * credential.helper` with NO scope flag, which resolves the actual EFFECTIVE
 * setting the same way git itself would (system → global → local →
 * worktree, all included files, `GIT_CONFIG_SYSTEM` honoured automatically)
 * and reports every value set for the key (a multivalued key is legal git
 * config). `--show-origin` prefixes each line with the origin (e.g.
 * `file:/etc/gitconfig\t...`), which is surfaced in `detail` — the origin is
 * a file path or a fixed git-defined label, never secret, unlike the helper
 * value itself (see the redaction comment below).
 */
async function checkNoGitCredentials(transport: IServerTransport): Promise<IsolationCheck> {
  const id = 'no_git_credentials';
  const cmd = 'if command -v git >/dev/null 2>&1; then '
    + 'OUT=$(git config --show-origin --get-all credential.helper 2>/dev/null); GIT_EXIT=$?; '
    + 'echo "AZT_GIT_EXIT:$GIT_EXIT"; '
    + 'printf \'%s\\n\' "$OUT"; '
    + 'echo AZT_HELPER_END; '
    + 'test -f "$HOME/.git-credentials" && echo AZT_CREDFILE_EXISTS || echo AZT_CREDFILE_ABSENT; '
    + 'else echo AZT_GIT_ABSENT; fi';
  let result;
  try {
    result = await execProbe(transport, cmd);
  } catch (err) {
    return { id, status: 'unknown', detail: `git credential 設定の確認に失敗しました（到達不能）: ${errMsg(err)}` };
  }
  if (result.code !== 0) {
    return { id, status: 'unknown', detail: execFailureDetail('git credential 設定の確認に失敗しました', result.code) };
  }
  const lines = result.stdout.split('\n').map((l) => l.trim());
  if (lines.includes('AZT_GIT_ABSENT')) {
    return { id, status: 'unknown', detail: 'git コマンドが見つからないため、credential 設定を確認できませんでした' };
  }
  const exitIdx = lines.findIndex((l) => /^AZT_GIT_EXIT:-?\d+$/.test(l));
  const helperEndIdx = lines.findIndex((l) => l === 'AZT_HELPER_END');
  if (exitIdx === -1 || helperEndIdx === -1 || helperEndIdx <= exitIdx) {
    return { id, status: 'unknown', detail: unrecognizedOutputDetail('git credential 設定の確認結果を解析できませんでした') };
  }
  const gitExit = Number(lines[exitIdx].slice('AZT_GIT_EXIT:'.length));
  // Each line is `<origin>\t<value>` (git's --show-origin framing). Review
  // round (Issue #29 5th pass, Minor finding 4): the shared `lines` array
  // above is `.trim()`-ed for locating the fixed control markers
  // (AZT_GIT_EXIT/AZT_HELPER_END/...), but `trim()` also strips a TRAILING
  // tab — exactly the shape a scope's empty-value reset line has
  // (`<origin>\t` with nothing after the tab, git's documented way to CLEAR
  // credential.helper). Slicing helper content out of the trimmed `lines`
  // silently turned every empty-value reset line into a tab-less,
  // "unrecognized origin-less noise" line that got skipped entirely —
  // dropping the very reset event this finding's fix needs to see. Helper
  // content is now sliced from the RAW (untrimmed, only CR-stripped)
  // stdout lines instead, using the same indices located via the trimmed
  // array above (the fixed marker lines themselves carry no meaningful
  // leading/trailing whitespace, so trimming for their own detection is
  // still safe). Lines without a tab are still unrecognized origin-less
  // noise and are skipped rather than misread as a bare helper value.
  const rawStdoutLines = result.stdout.split('\n').map((l) => l.replace(/\r$/, ''));
  const rawLines = rawStdoutLines.slice(exitIdx + 1, helperEndIdx).filter((l) => l !== '');
  const helperEntries: { origin: string; value: string }[] = [];
  for (const l of rawLines) {
    const tabIdx = l.indexOf('\t');
    if (tabIdx === -1) continue;
    helperEntries.push({ origin: l.slice(0, tabIdx), value: l.slice(tabIdx + 1) });
  }
  const rest = lines.slice(helperEndIdx + 1).join('\n');
  const credFileExists = rest.includes('AZT_CREDFILE_EXISTS');
  const credFileAbsent = rest.includes('AZT_CREDFILE_ABSENT');
  if (!credFileExists && !credFileAbsent) {
    return { id, status: 'unknown', detail: unrecognizedOutputDetail('~/.git-credentials の有無を確認できませんでした') };
  }
  if (gitExit !== 0 && gitExit !== 1) {
    return { id, status: 'unknown', detail: `git config --show-origin --get-all credential.helper が判別不能な exit code を返しました (exit ${gitExit})` };
  }
  // gitExit === 1: credential.helper キーがどのスコープにも存在しない（真の
  // 未設定）。
  if (gitExit === 1 && !credFileExists) {
    return { id, status: 'pass', detail: 'credential.helper 未設定、~/.git-credentials も不在です' };
  }
  const reasons: string[] = [];
  // Review round (Issue #29 5th pass, Minor finding 4, continued): gitExit
  // can be 0 (the key exists in SOME scope) while the reset-aware replay
  // below still resolves the EFFECTIVE set to empty — the canonical case
  // this finding is about, e.g. system sets a real helper and global resets
  // it with `credential.helper =`. That must reach the same 'pass' outcome
  // as the gitExit===1 case above, not fall through to a 'fail' with an
  // empty `reasons` array (which the code below would otherwise produce).
  // Deferred until after `configuredEntries` is computed, so this check sits
  // right below its own comment describing the replay.
  // Review finding (Step 2 review, Important #4): a helper's raw VALUE is a
  // shell command string (`credential.helper` can be `!<command>`, e.g.
  // `!aws codecommit credential-helper $@`, or `store --file
  // /path/with/user:pass@host`) that can itself embed a username/password/
  // token. It must never reach `detail` verbatim — this report is persisted
  // to `isolation_report`, surfaced through the audit log, and rendered in
  // the browser (see routes.ts's POST .../isolation/doctor and
  // OverviewSection.tsx). Only classify the helper into a coarse shape
  // (never the value itself) so a human still learns SOMETHING actionable
  // ("a helper is configured, here's roughly what kind, and from where").
  // The ORIGIN (file path / git-defined label) is safe to show as-is — it
  // carries no capability, unlike the value.
  // Review round (Issue #29 5th pass, Minor finding 4): git's own semantics
  // for a multivalued config key are cumulative-with-reset, not
  // filter-out-blanks — `--show-origin --get-all` lists every scope's value
  // IN RESOLUTION ORDER (system, then global, then local, ...), and a scope
  // that sets `credential.helper =` (empty) is git's documented way to CLEAR
  // everything accumulated so far, not merely "one more, ignorable entry".
  // The previous `.filter((e) => e.value !== '')` treated every non-empty
  // entry as still active regardless of a later reset — e.g. system sets a
  // real helper, global resets it to empty — and reported the system-scope
  // helper as configured even though git's actual effective helper set is
  // empty. Replayed here in the same order git resolves them: an empty value
  // clears the accumulator; a non-empty value appends to it. Only what
  // survives to the end is "configured".
  let configuredEntries: { origin: string; value: string }[] = [];
  for (const entry of helperEntries) {
    if (entry.value === '') configuredEntries = [];
    else configuredEntries.push(entry);
  }
  if (configuredEntries.length === 0 && !credFileExists) {
    return { id, status: 'pass', detail: 'credential.helper の実効設定は空です（上位スコープの設定が下位スコープで空リセットされています）、~/.git-credentials も不在です' };
  }
  if (configuredEntries.length > 0) {
    const kinds = Array.from(new Set(configuredEntries.map((e) => classifyGitCredentialHelper(e.value))));
    const origins = Array.from(new Set(configuredEntries.map((e) => e.origin)));
    reasons.push(`credential.helper が設定されています（種別: ${kinds.join(', ')} / 設定元: ${origins.join(', ')}）`);
  }
  if (credFileExists) reasons.push('~/.git-credentials が存在します');
  return { id, status: 'fail', detail: reasons.join(' / ') };
}

/**
 * Coarse, value-free classification of a `credential.helper` setting for
 * report/audit-log display — never returns any substring of `helper` itself
 * (see checkNoGitCredentials's redaction comment above).
 */
function classifyGitCredentialHelper(helper: string): string {
  if (helper.startsWith('!')) return 'shell command (!...)';
  const first = helper.trim().split(/\s+/)[0] ?? '';
  const base = first.split('/').pop() || first;
  switch (base) {
    case 'store': return 'store';
    case 'cache': return 'cache';
    case 'osxkeychain': return 'osxkeychain';
    case 'manager': return 'manager';
    case 'manager-core': return 'manager-core';
    case 'libsecret': return 'libsecret';
    default: return 'other';
  }
}

/**
 * 5. `~/.azito/` の設定に operator トークンが無い — Issue #28
 * `azitoctlEnv.ts` の発見文法（`isAzitoctlEnvFilename` / `hasUiTokenLine`）
 * を再利用し、azitoctl*.env に `AZITO_UI_TOKEN=` 行が残っていないこと、
 * operator.env が存在しないことを確認する（`authDoctorCommand.ts`
 * checkAzitoctlEnvNoUiToken / checkOperatorEnvPermissions と同じ判定基準—
 * 再利用するのは検査の"定義"であって、この関数自体は独立した実行器: あちらは
 * ローカル fs、こちらは agent サーバーへの transport 経由）。
 *
 * Review round (Critical finding 2): file contents are now fetched via the
 * framed base64 batch (`probeFilesFramed`) instead of raw marker search —
 * see that function's own doc comment for why.
 */
async function checkNoOperatorToken(transport: IServerTransport): Promise<IsolationCheck> {
  const id = 'no_operator_token';
  let homeResult;
  try {
    homeResult = await execProbe(transport, 'echo "$HOME"');
  } catch (err) {
    return { id, status: 'unknown', detail: `$HOME の解決に失敗しました（到達不能）: ${errMsg(err)}` };
  }
  const remoteHome = homeResult.stdout.trim();
  if (homeResult.code !== 0 || !remoteHome) {
    return { id, status: 'unknown', detail: execFailureDetail('$HOME の解決に失敗しました', homeResult.code) };
  }

  // Review round (Important finding 1): the previous command echoed the
  // `AZT_LS_DONE` terminator unconditionally after `ls`, discarding `ls`'s
  // own exit status — a `ls` that failed outright (directory exists but is
  // unreadable due to permissions, or any other listing error other than
  // "directory absent") produced empty/partial stdout indistinguishable from
  // "directory absent" or "directory genuinely empty", silently reporting
  // `'pass'` for a scan that never actually completed. The command now
  // distinguishes three outcomes via an explicit `AZT_LS_STATUS:<kind>` line
  // captured from `ls`'s own `$?`: `absent` (the `[ -d ]` test itself failed
  // — nothing to scan, a legitimate pass path), `listed` (the directory
  // exists AND `ls` itself completed successfully), and `unreadable` (the
  // directory exists but `ls` failed — e.g. no execute permission) which
  // folds to `'unknown'`, never silently treated as "no targets found".
  const azitoDir = `${remoteHome}/.azito`;
  const quotedDir = shellQuote(azitoDir);
  const lsCmd = `if [ -d ${quotedDir} ]; then `
    + `if OUT=$(ls -1 ${quotedDir} 2>/dev/null); then `
    + `echo AZT_LS_STATUS:listed; printf '%s\\n' "$OUT"; echo AZT_LS_DONE; `
    + `else echo AZT_LS_STATUS:unreadable; fi; `
    + `else echo AZT_LS_STATUS:absent; fi`;
  let listResult;
  try {
    listResult = await execProbe(transport, lsCmd);
  } catch (err) {
    return { id, status: 'unknown', detail: `~/.azito の一覧取得に失敗しました（到達不能）: ${errMsg(err)}` };
  }
  if (listResult.code !== 0) {
    return { id, status: 'unknown', detail: execFailureDetail('~/.azito の一覧取得に失敗しました', listResult.code) };
  }
  const rawLines = listResult.stdout.split('\n').map((l) => l.trim());
  if (rawLines.includes('AZT_LS_STATUS:absent')) {
    return { id, status: 'pass', detail: '~/.azito ディレクトリが存在しません' };
  }
  if (rawLines.includes('AZT_LS_STATUS:unreadable')) {
    return { id, status: 'unknown', detail: '~/.azito が存在しますが、一覧取得に失敗しました（権限等で列挙不能）' };
  }
  const statusIdx = rawLines.indexOf('AZT_LS_STATUS:listed');
  const doneIdx = rawLines.indexOf('AZT_LS_DONE');
  if (statusIdx === -1 || doneIdx === -1 || doneIdx <= statusIdx) {
    return { id, status: 'unknown', detail: unrecognizedOutputDetail('~/.azito の一覧取得結果を解析できませんでした') };
  }
  const entries = rawLines.slice(statusIdx + 1, doneIdx).filter(Boolean);
  const targets = entries.filter((name) => isAzitoctlEnvFilename(name) || name === 'operator.env');
  if (targets.length === 0) {
    return { id, status: 'pass', detail: '~/.azito に azitoctl*.env / operator.env が存在しません' };
  }

  // Each candidate name is validated (regex / exact literal) above, but is
  // still attacker-influenced data from a remote `ls` — never interpolated
  // into the shell command unquoted. `probeFilesFramed`'s `key` is our own
  // numeric index (never remote data); `shellQuote` handles arbitrary
  // filename content in `pathExpr`.
  const probed = await probeFilesFramed(
    transport,
    targets.map((name, i) => ({ key: String(i), pathExpr: shellQuote(`${azitoDir}/${name}`) })),
  );
  if (!probed.ok) {
    return { id, status: 'unknown', detail: `azitoctl*.env / operator.env の内容取得に失敗しました: ${probed.detail}` };
  }

  const offenders: string[] = [];
  for (let i = 0; i < targets.length; i++) {
    const outcome = probed.results.get(String(i));
    if (!outcome || outcome.kind === 'unrecognized' || outcome.kind === 'unreadable') {
      return { id, status: 'unknown', detail: `${targets[i]} の内容取得結果が想定外の形式でした（読み取り不能）` };
    }
    if (outcome.kind === 'absent') continue; // listed by `ls` but gone by the time we read it — nothing to flag
    // operator.env carries AZITO_UI_TOKEN=... on the same line grammar
    // azitoctl*.env would if it were ever misconfigured — the same
    // predicate this doctor is already borrowing (see the doc comment
    // above) applies verbatim to both file kinds.
    if (/^AZITO_UI_TOKEN=/m.test(outcome.content)) {
      offenders.push(targets[i]);
    }
  }
  if (offenders.length > 0) {
    return { id, status: 'fail', detail: `AZITO_UI_TOKEN が残っているファイルがあります: ${offenders.join(', ')}` };
  }
  return { id, status: 'pass', detail: `確認済み: ${targets.join(', ')}` };
}

/**
 * 6. Claude の `~/.claude/settings.json` の MCP env に AZITO_UI_TOKEN が
 * 残っていない — `harness/setup.sh --purge-operator-token` が掃除する対象の
 * ひとつ（checkNoOperatorToken の doc comment、および
 * `shared/mcpTokenStores.ts` の doc comment を参照）。判定ロジック
 * （`extractClaudeMcpUiToken`）は `azito auth doctor`
 * （authDoctorCommand.ts の readMcpUiToken）と共有。
 */
async function checkNoClaudeMcpToken(transport: IServerTransport): Promise<IsolationCheck> {
  const id = 'no_claude_mcp_token';
  const probed = await probeFile(transport, '"$HOME/.claude/settings.json"');
  if (!probed.ok) return { id, status: 'unknown', detail: `Claude settings.json の${probed.detail}` };
  const { probe } = probed;
  if (probe.kind === 'absent') {
    return { id, status: 'pass', detail: '~/.claude/settings.json が存在しません' };
  }
  if (probe.kind === 'unrecognized' || probe.kind === 'unreadable') {
    return { id, status: 'unknown', detail: '~/.claude/settings.json の取得結果が想定外の形式でした（読み取り不能）' };
  }
  const extraction = extractClaudeMcpUiToken(probe.content);
  if (extraction.status === 'unreadable') {
    return { id, status: 'unknown', detail: `~/.claude/settings.json の JSON パースに失敗しました: ${extraction.error}` };
  }
  if (extraction.status === 'present') {
    return { id, status: 'fail', detail: '~/.claude/settings.json の mcpServers.azt-mcp.env に AZITO_UI_TOKEN が残っています' };
  }
  return { id, status: 'pass', detail: '~/.claude/settings.json に azt-mcp の AZITO_UI_TOKEN はありません' };
}

/**
 * 7. Codex の `config.toml`（`$CODEX_HOME` または `~/.codex`）の
 * `mcp_servers.azt-mcp` env に AZITO_UI_TOKEN が残っていない — 6 と同じ
 * cleanup 対象漏れを埋めるチェック。判定は `hasCodexConfigUiToken`
 * （`shared/mcpTokenStores.ts`）— `harness/setup.sh`
 * `strip_codex_ui_token()` 自身が最終防衛線として使っている保守的な
 * bare-substring スキャンと同じ考え方（採否の根拠は同関数の doc comment）。
 */
async function checkNoCodexMcpToken(transport: IServerTransport): Promise<IsolationCheck> {
  const id = 'no_codex_mcp_token';
  const probed = await probeFile(transport, '"${CODEX_HOME:-$HOME/.codex}/config.toml"');
  if (!probed.ok) return { id, status: 'unknown', detail: `Codex config.toml の${probed.detail}` };
  const { probe } = probed;
  if (probe.kind === 'absent') {
    return { id, status: 'pass', detail: 'config.toml が存在しません' };
  }
  if (probe.kind === 'unrecognized' || probe.kind === 'unreadable') {
    return { id, status: 'unknown', detail: 'config.toml の取得結果が想定外の形式でした（読み取り不能）' };
  }
  if (hasCodexConfigUiToken(probe.content)) {
    return { id, status: 'fail', detail: 'config.toml に AZITO_UI_TOKEN が残っています' };
  }
  return { id, status: 'pass', detail: 'config.toml に AZITO_UI_TOKEN はありません' };
}

/**
 * 8. 実行環境そのものに operator 相当のトークンが存在しない（review round,
 * Critical finding 3）: `/api/exec` は agent プロセスが継承した環境で
 * `/bin/sh` を起動するため、`AZITO_UI_TOKEN` 付きで起動された agent は
 * ディスク上に何も残っていなくてもそのトークンをコマンド実行環境から露出
 * する。ファイルベースの検査（5〜7）が全て pass でもこの経路は塞がれない
 * ため独立チェックとして追加。
 *
 * 値そのものは絶対に detail/report に含めない — `${VAR+x}` という POSIX
 * パラメータ展開（「設定されているか」だけを問う、値には触れない）で存在
 * 有無のみを問い合わせ、変数名のリストだけを報告する。
 *
 * Review round (Important finding 1): `AZITO_AGENT_TOKEN` is deliberately
 * EXCLUDED from `varsToCheck` — it is the hub<->agent TRANSPORT credential
 * (agent/main.ts requires it to start), not an operator-equivalent secret,
 * and every genuinely isolated agent server still needs it set for the hub
 * to reach `/api/exec` in the first place. Flagging its mere presence would
 * make this check fail permanently for every correctly-configured isolated
 * agent, which is worse than not checking at all (an operator who sees a
 * doctor that NEVER passes learns to ignore it). Only hub-side secrets that
 * grant operator-equivalent capability if leaked — UI/webhook/master-key —
 * belong here.
 */
async function checkNoOperatorEnvironment(transport: IServerTransport): Promise<IsolationCheck> {
  const id = 'no_operator_environment';
  const varsToCheck = ['AZITO_UI_TOKEN', 'AZITO_WEBHOOK_TOKEN', 'AZITO_MASTER_KEY'];
  const cmd = varsToCheck
    .map((v) => `if [ -n "\${${v}+x}" ]; then echo "AZT_ENV_PRESENT:${v}"; fi`)
    .join('; ') + '; echo AZT_ENV_DONE';
  let result;
  try {
    result = await execProbe(transport, cmd);
  } catch (err) {
    return { id, status: 'unknown', detail: `実行環境の変数確認に失敗しました（到達不能）: ${errMsg(err)}` };
  }
  if (result.code !== 0) {
    return { id, status: 'unknown', detail: execFailureDetail('実行環境の変数確認に失敗しました', result.code) };
  }
  const lines = result.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.includes('AZT_ENV_DONE')) {
    return { id, status: 'unknown', detail: unrecognizedOutputDetail('実行環境の変数確認結果を解析できませんでした') };
  }
  const present = lines
    .filter((l) => l.startsWith('AZT_ENV_PRESENT:'))
    .map((l) => l.slice('AZT_ENV_PRESENT:'.length));
  if (present.length > 0) {
    return {
      id,
      status: 'fail',
      detail: `/api/exec が起動する実行環境（プロセス継承環境）に operator 相当の環境変数が存在します。値は表示しません: ${present.join(', ')}`,
    };
  }
  return { id, status: 'pass', detail: '/api/exec が起動する実行環境に operator 相当の環境変数は見つかりませんでした' };
}

/**
 * 9. Forward された ssh-agent（`SSH_AUTH_SOCK`）経由で認証可能な鍵が無い。
 *
 * Review round (Important finding 4): checks 2〜8 は鍵ファイル・helper・
 * トークンの「静的な保管場所」しか見ておらず、それらが全て無くても
 * forward された ssh-agent ソケットが到達可能なら、そこに登録された鍵で
 * 認証できてしまう — 未検査の抜け道だった。
 *
 * `SSH_AUTH_SOCK` が実行環境に無ければ、そもそも agent へ到達する経路が
 * 存在しないため自明に `'pass'`。存在する場合は `ssh-add -l` の exit code
 * で分類する:
 *  - exit 0（鍵が1件以上登録されている）→ `'fail'`
 *  - exit 1（agent は稼働しているが登録鍵ゼロ）→ `'fail'` — ソケット自体が
 *    到達可能（forward 経路が生きている）ことは確認できており、その状態で
 *    鍵ゼロは一時的な状態でしかない（呼び出し元が後から鍵を追加すれば即座に
 *    認証可能になる）ため、経路が生きている以上は安全側に倒して fail 扱いと
 *    する（採否は本チェック固有の判断であり、モジュール冒頭のドクトリンに
 *    追記するほどの一般則ではない）
 *  - exit 2、または `ssh-add` コマンド自体が不在 → `'unknown'`（agent に
 *    接続できない/確認手段が無い。`SSH_AUTH_SOCK` 変数だけが残った死骸
 *    ソケットの可能性もあるが、その断定はできない）
 *
 * 鍵の指紋・コメント等は detail に含めない（登録件数のみ）。
 */
async function checkNoSshAgent(transport: IServerTransport): Promise<IsolationCheck> {
  const id = 'no_ssh_agent';
  const cmd = 'if [ -n "${SSH_AUTH_SOCK+x}" ]; then '
    + 'if command -v ssh-add >/dev/null 2>&1; then '
    + 'OUT=$(ssh-add -l 2>/dev/null); SSH_ADD_EXIT=$?; '
    + 'echo "AZT_SSHADD_EXIT:$SSH_ADD_EXIT"; '
    + 'echo "AZT_SSHADD_COUNT:$(printf \'%s\\n\' "$OUT" | grep -c .)"; '
    + 'else echo AZT_SSHADD_ABSENT; fi; '
    + 'else echo AZT_NO_SOCK; fi';
  let result;
  try {
    result = await execProbe(transport, cmd);
  } catch (err) {
    return { id, status: 'unknown', detail: `ssh-agent の確認に失敗しました（到達不能）: ${errMsg(err)}` };
  }
  if (result.code !== 0) {
    return { id, status: 'unknown', detail: execFailureDetail('ssh-agent の確認に失敗しました', result.code) };
  }
  const lines = result.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.includes('AZT_NO_SOCK')) {
    return { id, status: 'pass', detail: 'SSH_AUTH_SOCK が設定されていません（forward された ssh-agent 経路はありません）' };
  }
  if (lines.includes('AZT_SSHADD_ABSENT')) {
    return { id, status: 'unknown', detail: 'ssh-add コマンドが見つからないため、ssh-agent の鍵登録状況を確認できませんでした（SSH_AUTH_SOCK は設定されています）' };
  }
  const exitLine = lines.find((l) => /^AZT_SSHADD_EXIT:-?\d+$/.test(l));
  const countLine = lines.find((l) => /^AZT_SSHADD_COUNT:\d+$/.test(l));
  if (!exitLine) {
    return { id, status: 'unknown', detail: unrecognizedOutputDetail('ssh-agent の確認結果を解析できませんでした') };
  }
  const sshAddExit = Number(exitLine.slice('AZT_SSHADD_EXIT:'.length));
  const count = countLine ? Number(countLine.slice('AZT_SSHADD_COUNT:'.length)) : null;
  if (sshAddExit === 0) {
    return { id, status: 'fail', detail: `SSH_AUTH_SOCK に到達可能な ssh-agent が稼働しており、鍵が登録されています（${count ?? '不明'}件）` };
  }
  if (sshAddExit === 1) {
    return { id, status: 'fail', detail: 'SSH_AUTH_SOCK に到達可能な ssh-agent が稼働しています（現在の登録鍵は0件ですが、forward 経路自体が生きています）' };
  }
  return {
    id,
    status: 'unknown',
    detail: `ssh-add が判別不能な exit code を返しました (exit ${sshAddExit}) — ssh-agent に接続できなかった可能性があります（SSH_AUTH_SOCK は設定されています）`,
  };
}

export async function runIsolationDoctor(transport: IServerTransport, hub: HubIdentity): Promise<IsolationDoctorResult> {
  const checks = await Promise.all([
    checkFsAndHostBoundary(transport, hub),
    checkNoPrivateKeys(transport),
    checkGhUnauthenticated(transport),
    checkNoGitCredentials(transport),
    checkNoOperatorToken(transport),
    checkNoClaudeMcpToken(transport),
    checkNoCodexMcpToken(transport),
    checkNoOperatorEnvironment(transport),
    checkNoSshAgent(transport),
  ]);
  const verified = checks.every((c) => c.status === 'pass');
  return { verified, checks };
}
