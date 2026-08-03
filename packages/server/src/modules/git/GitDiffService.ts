import type { ServerConfig } from '../servers/Server';
import type { TransportFactory } from '../servers/transport/TransportFactory';
import { parseUnifiedDiff, type FileDiff } from './DiffParser';
import { stripTerminalArtifacts } from '../../shared/utils/stripTerminalArtifacts';

import { SAFE_PATH_PATTERN, SAFE_BRANCH_PATTERN } from './assertSafeGitArgs';
export { SAFE_PATH_PATTERN as SAFE_PATH, SAFE_BRANCH_PATTERN as SAFE_BRANCH };
export const SAFE_HASH = /^[0-9a-f]{7,40}$/;

const MAX_DIFF_SIZE = 1_000_000;

export interface GitDiffResult {
  baseBranch: string;
  headBranch: string;
  files: FileDiff[];
  truncated: boolean;
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
}

export class GitDiffService {
  constructor(private readonly transportFactory: TransportFactory) {}

  async getCommits(srv: ServerConfig, dirPath: string, base?: string): Promise<GitCommit[]> {
    if (base && !SAFE_BRANCH_PATTERN.test(base)) throw new Error(`Invalid base branch: ${base}`);
    const transport = this.transportFactory.getTransport(srv);
    const safeDir = dirPath.replace(/'/g, "'\\''");

    const range = base ? `${base}..HEAD` : '-50 HEAD';
    const FIELD_SEP = '<<>>';
    const RECORD_SEP = '<<||>>';
    const fmt = `%H${FIELD_SEP}%h${FIELD_SEP}%an${FIELD_SEP}%aI${FIELD_SEP}%s${RECORD_SEP}`;
    const cmd = `git -c core.quotepath=false -C '${safeDir}' log --pretty=format:'${fmt}' ${range}`;
    const result = await transport.exec(cmd);

    const combined = `${result.stdout}\n${result.stderr}`.trim();
    if (result.code !== 0 || /^fatal:|^error:/m.test(combined)) {
      throw new Error(`git log failed: ${combined || `exit ${result.code}`}`);
    }

    const raw = stripTerminalArtifacts(result.stdout);
    return raw
      .split(RECORD_SEP)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(FIELD_SEP);
        const [hash, shortHash, author, date] = parts;
        const subject = parts.slice(4).join(FIELD_SEP);
        return { hash, shortHash, author, date, subject };
      });
  }

  /** GET /api/servers/:name/git/diff 用: 作業ディレクトリの unified diff を取得 */
  async getDiff(srv: ServerConfig, dirPath: string, base: string, commit?: string): Promise<GitDiffResult> {
    // Defensive boundary check: base is embedded in a shell command below.
    if (base && !SAFE_BRANCH_PATTERN.test(base)) throw new Error(`Invalid base branch: ${base}`);
    if (commit && !SAFE_HASH.test(commit)) throw new Error(`Invalid commit hash: ${commit}`);
    const transport = this.transportFactory.getTransport(srv);
    const safeDir = dirPath.replace(/'/g, "'\\''");

    let diffCmd: string;
    let baseBranch: string;
    let headBranch: string;

    if (commit) {
      diffCmd = `git -c core.quotepath=false -C '${safeDir}' show --format= --unified=3 ${commit}`;
      baseBranch = `${commit}^`;
      headBranch = commit.slice(0, 7);
    } else {
      const headResult = await transport.exec(`git -C '${safeDir}' rev-parse --abbrev-ref HEAD 2>/dev/null`);
      headBranch = stripTerminalArtifacts(headResult.stdout).trim() || 'HEAD';

      const diffRef = base ? `${base}...HEAD` : 'HEAD';
      diffCmd = `git -c core.quotepath=false -C '${safeDir}' diff --unified=3 ${diffRef}`;
      baseBranch = base || 'HEAD';
    }

    const diffResult = await transport.exec(diffCmd);
    // SSH transports always report code 0, so also detect git errors in the output.
    const combined = `${diffResult.stdout}\n${diffResult.stderr}`.trim();
    if (diffResult.code !== 0 || /^fatal:|^error:/m.test(combined)) {
      throw new Error(`git diff failed: ${combined || `exit ${diffResult.code}`}`);
    }
    const rawDiff = stripTerminalArtifacts(diffResult.stdout);

    let truncated = false;
    let files = parseUnifiedDiff(rawDiff);

    if (rawDiff.length > MAX_DIFF_SIZE) {
      truncated = true;
      files = files.map((f) => {
        const totalLines = f.hunks.reduce((sum, h) => sum + h.lines.length, 0);
        if (totalLines > 500) {
          return { ...f, hunks: f.hunks.slice(0, 3) };
        }
        return f;
      });
    }

    return { baseBranch, headBranch, files, truncated };
  }
}
