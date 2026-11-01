// ─── Strip terminal artifacts from remote command output ───

const stripNonCsiControls = (s: string): string =>
  s
    // OSC sequences (title, hyperlinks, etc.)
    .replace(/\x1b\].*?(?:\x1b\\|\x07)/g, '')
    // Charset selection
    .replace(/\x1b[()][AB012]/g, '')
    // STX markers (from SSH shell)
    .replace(/\x02/g, '')
    // Other C0/C1 control chars (except \n \r \t)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');

/** Every ECMA-48 CSI sequence (private parameters such as `?25h` included) and the other control characters; text is kept as is. */
export const stripTerminalControlSequences = (s: string): string =>
  stripNonCsiControls(s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ''));

export const stripTerminalArtifacts = (s: string): string =>
  stripNonCsiControls(
    // CSI sequences (colors, cursor movement, etc.)
    s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, ''),
  )
    // Private Use Area (Nerd Font icons U+E000–U+F8FF).
    // Written as escapes on purpose: raw PUA chars are invisible in editors and were
    // once silently dropped from this file, turning the class into /[-]/ — which then
    // stripped every hyphen from remote output (file names, git diff "-" lines).
    .replace(/[\uE000-\uF8FF]/g, '')
    // Common emoji ranges (folder/file icons etc.)
    .replace(/[\u{1F300}-\u{1F9FF}]/gu, '');
