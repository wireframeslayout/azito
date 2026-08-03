import React from 'react';

// Claude AI symbol — Wikimedia Commons (CC0)
// https://commons.wikimedia.org/wiki/File:Claude_AI_symbol.svg
export function ClaudeIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none" style={{ display: 'block' }}>
      <path fill="currentColor" d="m19.6 66.5 19.7-11 .3-1-.3-.5h-1l-3.3-.2-11.2-.3L14 53l-9.5-.5-2.4-.5L0 49l.2-1.5 2-1.3 2.9.2 6.3.5 9.5.6 6.9.4L38 49.1h1.6l.2-.7-.5-.4-.4-.4L29 41l-10.6-7-5.6-4.1-3-2-1.5-2-.6-4.2 2.7-3 3.7.3.9.2 3.7 2.9 8 6.1L37 36l1.5 1.2.6-.4.1-.3-.7-1.1L33 25l-6-10.4-2.7-4.3-.7-2.6c-.3-1-.4-2-.4-3l3-4.2L28 0l4.2.6L33.8 2l2.6 6 4.1 9.3L47 29.9l2 3.8 1 3.4.3 1h.7v-.5l.5-7.2 1-8.7 1-11.2.3-3.2 1.6-3.8 3-2L61 2.6l2 2.9-.3 1.8-1.1 7.7L59 27.1l-1.5 8.2h.9l1-1.1 4.1-5.4 6.9-8.6 3-3.5L77 13l2.3-1.8h4.3l3.1 4.7-1.4 4.9-4.4 5.6-3.7 4.7-5.3 7.1-3.2 5.7.3.4h.7l12-2.6 6.4-1.1 7.6-1.3 3.5 1.6.4 1.6-1.4 3.4-8.2 2-9.6 2-14.3 3.3-.2.1.2.3 6.4.6 2.8.2h6.8l12.6 1 3.3 2 1.9 2.7-.3 2-5.1 2.6-6.8-1.6-16-3.8-5.4-1.3h-.8v.4l4.6 4.5 8.3 7.5L89 80.1l.5 2.4-1.3 2-1.4-.2-9.2-7-3.6-3-8-6.8h-.5v.7l1.8 2.7 9.8 14.7.5 4.5-.7 1.4-2.6 1-2.7-.6-5.8-8-6-9-4.7-8.2-.5.4-2.9 30.2-1.3 1.5-3 1.2-2.5-2-1.4-3 1.4-6.2 1.6-8 1.3-6.4 1.2-7.9.7-2.6v-.2H49L43 72l-9 12.3-7.2 7.6-1.7.7-3-1.5.3-2.8L24 86l10-12.8 6-7.9 4-4.6-.1-.5h-.3L17.2 77.4l-4.7.6-2-2 .2-3 1-1 8-5.5Z" />
    </svg>
  );
}

export function CodexIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ display: 'block' }}>
      <path d="M22.282 9.821a5.985 5.985 0 00-.516-4.91 6.046 6.046 0 00-6.51-2.9A6.065 6.065 0 0011.788.206a6.046 6.046 0 00-5.772 4.206 5.998 5.998 0 00-3.978 2.903 6.046 6.046 0 00.749 7.091 5.985 5.985 0 00.516 4.911 6.046 6.046 0 006.51 2.9A6.065 6.065 0 0013.288 24a6.046 6.046 0 005.772-4.206 5.998 5.998 0 003.978-2.903 6.046 6.046 0 00-.756-7.07zM13.288 22.212a4.487 4.487 0 01-2.883-1.049l.143-.082 4.792-2.767a.779.779 0 00.393-.676v-6.751l2.025 1.169a.072.072 0 01.039.054v5.592a4.504 4.504 0 01-4.509 4.51zm-9.686-4.134a4.483 4.483 0 01-.537-3.015l.143.086 4.792 2.767a.779.779 0 00.785 0l5.853-3.379v2.339a.072.072 0 01-.029.06L9.759 19.72a4.504 4.504 0 01-6.157-1.642zM2.477 7.874A4.485 4.485 0 014.826 5.9l-.001.166v5.534a.779.779 0 00.392.676l5.853 3.379-2.025 1.169a.072.072 0 01-.068.006L4.126 14.07a4.504 4.504 0 01-1.649-6.196zm16.636 3.873l-5.853-3.379L15.285 7.2a.072.072 0 01.068-.006l4.851 2.78a4.504 4.504 0 01-.682 8.128v-5.7a.779.779 0 00-.409-.655zm2.015-3.023l-.143-.085-4.792-2.768a.779.779 0 00-.785 0L9.555 9.25V6.911a.072.072 0 01.029-.06l4.851-2.8a4.504 4.504 0 016.693 4.673zm-12.672 4.17l-2.025-1.17a.072.072 0 01-.039-.054V6.078a4.504 4.504 0 017.391-3.457l-.143.082-4.792 2.767a.779.779 0 00-.392.676v6.748zm1.1-2.373l2.607-1.505 2.607 1.505v3.01l-2.607 1.505-2.607-1.505v-3.01z" fill="currentColor" />
    </svg>
  );
}

export function TerminalIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={{ display: 'block' }}>
      <rect x="1" y="2" width="14" height="12" rx="2" stroke="currentColor" strokeWidth="1.2" fill="none" />
      <path d="M4 6l2.5 2L4 10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="8" y1="10" x2="11" y2="10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

export const AGENT_ICON_MAP: Record<string, React.FC<{ size?: number }>> = {
  claude: ClaudeIcon,
  codex: CodexIcon,
  terminal: TerminalIcon,
};

export function AgentIcon({ workerType, windowType, size = 16 }: {
  workerType?: string | null;
  windowType?: string;
  size?: number;
}) {
  if (windowType === 'agent' && workerType) {
    const Icon = AGENT_ICON_MAP[workerType] ?? TerminalIcon;
    return <Icon size={size} />;
  }
  return <TerminalIcon size={size} />;
}
