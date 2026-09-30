export interface TmuxAttachPlan {
  prepare: string[][];
  attach: string[];
  fallbackAttach: string[];
  cleanup: string[];
}

export function buildTmuxAttachPlan(
  sessionName: string,
  windowTarget: string,
  linkedName: string,
  publicUrl: string,
): TmuxAttachPlan {
  return {
    prepare: [
      ['list-panes', '-t', `${sessionName}:${windowTarget}`],
      ['set-option', '-s', 'set-clipboard', 'on'],
      ['new-session', '-d', '-t', sessionName, '-s', linkedName, '-e', `AZITO_URL=${publicUrl}`],
      ['set-option', '-t', linkedName, 'status', 'off'],
      ['select-window', '-t', `${linkedName}:${windowTarget}`],
    ],
    attach: ['attach-session', '-t', linkedName],
    fallbackAttach: ['attach-session', '-t', `${sessionName}:${windowTarget}`],
    cleanup: ['kill-session', '-t', linkedName],
  };
}
