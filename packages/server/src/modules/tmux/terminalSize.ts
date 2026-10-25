/**
 * The size of a terminal the UI opens when it does not say (the same 120x40 the terminal WebSocket defaults to in `buildServer.ts` and
 * the agent). A pane that is started before any terminal is attached to it starts with this size: a Node TUI on Windows (Claude Code)
 * does not follow a later ConPTY resize (a known misao limit), so its first size must already be the one the UI shows.
 */
export const DEFAULT_TERMINAL_COLS = 120;
export const DEFAULT_TERMINAL_ROWS = 40;
