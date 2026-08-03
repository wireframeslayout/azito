import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { isSameWindowTarget } from '../utils/tmuxTarget';
import { useNotificationChannel } from './useNotificationChannel';

/** Mirrors the server's `GET /api/windows/pane-loading-state` response. `ready: null` means "no
 * live tui-supervisor connection yet" — which is expected right after a supervised window is
 * created (send-keys happens before the supervisor process has had time to register with the
 * hub), and is why `supervised` (the window's persisted flag, independent of any live connection)
 * has to be consulted too: without it, "not registered yet" is indistinguishable from "not a
 * supervised window at all", and the overlay would fail open onto the raw wrapped launch command
 * echoing in the pane — exactly what it exists to hide. */
interface PaneLoadingState {
  supervised: boolean;
  ready: boolean | null;
  childCommand: string | null;
}

export type LoadingOverlayPhase = 'connecting' | 'launching' | 'timeout';

export interface LoadingOverlayState {
  /** Whether the overlay element should still be in the DOM (false once the fade-out transition has finished). */
  mounted: boolean;
  /** Whether the overlay is currently transitioning to opacity 0. */
  fadingOut: boolean;
  phase: LoadingOverlayPhase;
  /** First token of the supervised child's launch command (e.g. `claude`), set only while `phase === 'launching'`. */
  agentToken: string | null;
  /** Call once, when the terminal WebSocket receives its first message (pane output actually started flowing). */
  markConnected: () => void;
  /** Wire to the overlay element's `onTransitionEnd` so it unmounts once the fade-out finishes. */
  handleTransitionEnd: (event: { propertyName: string }) => void;
}

const LAUNCH_TIMEOUT_MS = 10_000;
const TIMEOUT_HOLD_MS = 2_000;

type SupervisedDecision = 'pending' | 'wait' | 'skip';

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

function firstToken(command: string): string | null {
  return command.trim().split(/\s+/)[0] ?? null;
}

/**
 * Drives the XTermView loading overlay's phase/fade state.
 *
 * Non-supervised panes resolve the instant the first WS message arrives (unchanged behavior).
 * Supervised panes (a `tui-supervisor` process wraps the child TUI) hold at the "launching" phase
 * until either a `supervisor:ready` event arrives for this server/target, or `LAUNCH_TIMEOUT_MS`
 * elapses from mount — whichever comes first. The 10s deadline is an absolute timestamp fixed at
 * mount (not merely "10s after entering launching") so that whichever branch reaches 'launching'
 * late (the supervised/non-supervised decision resolves asynchronously via fetch) still lands on
 * the correct remaining budget instead of getting a fresh 10s.
 */
export function useSupervisedLoadingOverlay(serverName: string, target: string): LoadingOverlayState {
  const [mounted, setMounted] = useState(true);
  const [fadingOut, setFadingOut] = useState(false);
  const [phase, setPhase] = useState<LoadingOverlayPhase>('connecting');
  const [agentToken, setAgentToken] = useState<string | null>(null);

  const connectedRef = useRef(false);
  const resolvedRef = useRef(false);
  /** Set once we've learned (via `supervisor:ready` or a re-synced snapshot) that the
   * supervised child TUI has finished booting. Kept separate from `decisionRef` so "ready
   * arrived before the terminal WS's first byte" can be remembered without prematurely
   * fading the overlay — see applyDecisionIfReady's resolve condition. */
  const readyRef = useRef(false);
  const decisionRef = useRef<SupervisedDecision>('pending');
  const phaseRef = useRef<LoadingOverlayPhase>('connecting');
  const launchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Absolute epoch-ms deadline for the launch wait, fixed once at mount. */
  const deadlineRef = useRef(0);

  const setPhaseTracked = (next: LoadingOverlayPhase) => {
    phaseRef.current = next;
    setPhase(next);
  };

  const fadeOut = () => {
    if (resolvedRef.current) return;
    resolvedRef.current = true;
    if (launchTimerRef.current) clearTimeout(launchTimerRef.current);
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    if (prefersReducedMotion()) {
      setMounted(false);
      return;
    }
    setFadingOut(true);
  };

  /** Enters the orange "stalled" treatment directly — used both by the normal 10s timer fire
   * and by the "already past deadline" fast-path when we only just now reached 'launching'. */
  const enterTimeoutState = () => {
    if (resolvedRef.current) return;
    resolvedRef.current = true; // locks out further decision/ready-driven phase changes
    setPhaseTracked('timeout');
    holdTimerRef.current = setTimeout(() => {
      if (prefersReducedMotion()) {
        setMounted(false);
        return;
      }
      setFadingOut(true);
    }, TIMEOUT_HOLD_MS);
  };

  const fireTimeout = () => {
    if (resolvedRef.current) return;
    if (phaseRef.current !== 'launching') {
      // The 10s mark hit before we ever reached the "launching" phase — either the
      // pane-loading-state fetch never settled (hung, so decisionRef stayed 'pending')
      // or connectedRef never flipped true. If the WS's first byte already arrived
      // (connectedRef true), the pane itself is fine — only our own supervised-wait
      // bookkeeping is stuck — so fade out silently rather than holding the overlay
      // forever (this used to always resolve on first byte; don't regress that).
      // If the WS hasn't connected at all yet, keep showing "connecting" as before.
      if (connectedRef.current) fadeOut();
      return;
    }
    enterTimeoutState();
  };

  /** (Re)schedules the single launch timer for `ms` from now, clearing any previous one first
   * so a late transition into 'launching' never ends up with two timers racing. */
  const scheduleLaunchTimer = (ms: number) => {
    if (launchTimerRef.current) clearTimeout(launchTimerRef.current);
    launchTimerRef.current = setTimeout(fireTimeout, Math.max(ms, 0));
  };

  const applyDecisionIfReady = () => {
    if (resolvedRef.current || !connectedRef.current) return;
    // The terminal WS's first byte is the hard prerequisite (never fade before it — that's
    // the "always cover until first byte" guarantee) — but once that has happened, either the
    // supervisor already reporting ready or a plain non-supervised/'skip' decision resolves
    // immediately, checked ahead of the still-pending-decision case below.
    if (readyRef.current || decisionRef.current === 'skip') {
      fadeOut();
      return;
    }
    if (decisionRef.current === 'pending') return;
    setPhaseTracked('launching');
    // We may be reaching 'launching' well after mount (the supervised/non-supervised decision
    // resolves asynchronously) — re-derive the remaining budget against the fixed deadline
    // rather than assuming a fresh 10s, and rather than assuming the mount-time timer is still
    // the one that will fire (see fireTimeout's early-return branch above: it may already have
    // fired once, silently, while we were still in 'connecting').
    const remaining = deadlineRef.current - Date.now();
    if (remaining <= 0) {
      enterTimeoutState();
    } else {
      scheduleLaunchTimer(remaining);
    }
  };

  /** Looks up this pane's loading state. Shared by the mount-time fetch and the
   * reconnect-triggered re-sync (see onConnected below). Window-granularity match (pane suffix
   * stripped) happens server-side, matching isSameWindowTarget's rule. */
  const fetchPaneLoadingState = (): Promise<PaneLoadingState> =>
    api<PaneLoadingState>(
      `/windows/pane-loading-state?server_name=${encodeURIComponent(serverName)}&tmux_target=${encodeURIComponent(target)}`,
    );

  useEffect(() => {
    // Reset per server/target change (a new pane mount).
    connectedRef.current = false;
    resolvedRef.current = false;
    readyRef.current = false;
    decisionRef.current = 'pending';
    setMounted(true);
    setFadingOut(false);
    setAgentToken(null);
    setPhaseTracked('connecting');

    deadlineRef.current = Date.now() + LAUNCH_TIMEOUT_MS;
    scheduleLaunchTimer(LAUNCH_TIMEOUT_MS);

    let cancelled = false;
    fetchPaneLoadingState()
      .then((state) => {
        if (cancelled) return;
        // ready:true → already booted, nothing to wait for. ready:false → a supervisor is
        // connected and mid-boot, wait. ready:null (no live connection yet) falls back to the
        // window's persisted `supervised` flag: true means "supervised, just not registered with
        // the hub yet" (still worth waiting for), false means a plain unsupervised pane.
        const shouldWait = state.ready === false || (state.ready === null && state.supervised);
        decisionRef.current = shouldWait ? 'wait' : 'skip';
        if (shouldWait && state.childCommand) setAgentToken(firstToken(state.childCommand));
        applyDecisionIfReady();
      })
      .catch(() => {
        // Fail open: never hold the terminal hostage for a broken pane-loading-state lookup.
        if (cancelled) return;
        decisionRef.current = 'skip';
        applyDecisionIfReady();
      });

    return () => {
      cancelled = true;
      if (launchTimerRef.current) clearTimeout(launchTimerRef.current);
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverName, target]);

  useNotificationChannel({
    onSupervisorReady: (payload) => {
      if (payload.serverName !== serverName || !isSameWindowTarget(payload.target, target)) return;
      // Record readiness even if the terminal WS hasn't delivered its first byte yet —
      // applyDecisionIfReady only ever fades once connectedRef is true, so this can't
      // uncover an empty terminal early; it just means markConnected() resolves instantly.
      readyRef.current = true;
      applyDecisionIfReady();
    },
    // The shared events WS may have been disconnected/reconnecting exactly when the supervisor
    // sent 'ready' — that broadcast is then lost for good (it's not re-sent on our behalf). Every
    // reconnect, re-check the snapshot ourselves so we don't sit out the full 10s timeout for
    // something that already finished while we were offline.
    onConnected: () => {
      if (resolvedRef.current || decisionRef.current === 'skip') return;
      fetchPaneLoadingState()
        .then((state) => {
          if (resolvedRef.current) return;
          // Ready, or definitively not supervised (ready:null && supervised:false — nothing left
          // to wait for) — record it and let applyDecisionIfReady decide (still gated on
          // connectedRef, same as above). An absent/not-yet-registered supervisor connection
          // (ready:null) does NOT resolve on its own when `supervised` is true — the window may
          // simply not have registered with the hub yet, and the 10s deadline is what bounds
          // that wait, not this re-sync.
          const resolved = state.ready === true || (state.ready === null && !state.supervised);
          if (resolved) {
            readyRef.current = true;
            applyDecisionIfReady();
          }
          // Otherwise (ready:false, or ready:null && supervised:true): leave phase/decision as-is.
        })
        .catch(() => { /* best-effort resync; the existing ready-event/timeout paths still apply */ });
    },
  });

  const markConnected = () => {
    connectedRef.current = true;
    applyDecisionIfReady();
  };

  const handleTransitionEnd = (event: { propertyName: string }) => {
    if (event.propertyName !== 'opacity') return;
    setMounted(false);
  };

  return { mounted, fadingOut, phase, agentToken, markConnected, handleTransitionEnd };
}
