import { InstallSteps } from '@azito/frontend';

export const InProgress = () => (
  <InstallSteps
    steps={[
      { step: 'connect', status: 'ok', message: 'ssh wakanda (tailscale, none auth)' },
      { step: 'bundle', status: 'ok', message: 'agent bundle 4.2 MB staged' },
      { step: 'copy', status: 'ok', message: 'scp to ~/.azito/agent' },
      { step: 'launch', status: 'running', message: 'starting agent process via nohup' },
    ]}
  />
);

export const CompletedInstall = () => (
  <InstallSteps
    steps={[
      { step: 'connect', status: 'ok', message: 'ssh server02:22' },
      { step: 'harness', status: 'ok', message: 'azt-* skills installed' },
      { step: 'hooks', status: 'ok', message: 'azito-activity.sh wired to Claude Code' },
      { step: 'verify', status: 'ok', message: 'agent v0.3.0 responding on :7070' },
    ]}
  />
);

export const FailedStep = () => (
  <InstallSteps
    steps={[
      { step: 'connect', status: 'ok', message: 'ssh wakanda' },
      { step: 'bundle', status: 'ok', message: 'agent bundle staged' },
      { step: 'launch', status: 'error', message: 'node not found on remote PATH' },
    ]}
  />
);
