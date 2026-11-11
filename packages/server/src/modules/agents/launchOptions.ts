export interface LaunchOptions {
  model?: string | null;
  extraArgs?: string | null;
  /** When false, omit MCP blocking flags. Default true (fail-closed). */
  blockMcp?: boolean;
  defaultPermissionFlags?: boolean;
  recordedArgs?: readonly string[];
}

