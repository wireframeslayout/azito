export function isMuxSwitchError(error?: string): boolean {
  return error === 'misao_unavailable' || error === 'window_busy' || error === 'unsupported_switch';
}

export function describeWakeError(result: { error?: string; message?: string; reason?: string }, translate: (key: string) => string): string {
  if (!isMuxSwitchError(result.error)) return result.message || result.error || translate('terminal.muxErrorUnknown');
  const message = translate(muxSwitchErrorKey(result.error, result.reason));
  return result.error === 'misao_unavailable' ? `${message} ${translate('terminal.muxErrorGuide')}` : message;
}

/** Translation key for a respawn failure. Unknown reasons remain user-readable. */
export function muxSwitchErrorKey(error?: string, reason?: string): string {
  if (error === 'window_busy') return 'terminal.muxErrorBusy';
  if (error === 'unsupported_switch') return 'terminal.muxErrorUnsupported';
  if (error === 'misao_unavailable') {
    switch (reason) {
      case 'daemon_unreachable': return 'terminal.muxErrorDaemon';
      case 'not_installed': return 'terminal.muxErrorNotInstalled';
      case 'protocol_incompatible': return 'terminal.muxErrorProtocol';
      case 'driver_not_registered': return 'terminal.muxErrorDriver';
      case 'unsupported_os': return 'terminal.muxErrorOs';
    }
  }
  return 'terminal.muxErrorUnknown';
}
