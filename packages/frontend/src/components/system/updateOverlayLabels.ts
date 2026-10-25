import type { UpdateStep } from '../../hooks/useSystemUpdate';

export const STEP_LABEL_KEYS: Record<UpdateStep, string> = {
  download: 'updateOverlay.stepDownload',
  verify: 'updateOverlay.stepVerify',
  extract: 'updateOverlay.stepExtract',
  'smoke-test': 'updateOverlay.stepSmokeTest',
  switch: 'updateOverlay.stepSwitch',
  restart: 'updateOverlay.stepRestart',
  'health-check': 'updateOverlay.stepHealthCheck',
};

/** A version here is a release tag (`v0.12.0-rc.1`), not a commit sha, so it is shown whole. */
export function formatUpdateVersion(version: string): string {
  return version.trim();
}
