import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { IServerTransport } from '../../servers/transport/ServerTransport';
import { shellQuote } from '../../../shared/shellQuote';

export type EnsureClaudeTrustResult =
  | { action: 'registered' }
  | { action: 'already_trusted' }
  | { action: 'skipped'; reason: string }
  | { action: 'failed'; reason: string };

const REMOTE_TIMEOUT_MS = 10_000;

const REMOTE_SCRIPT = [
  'const fs=require("fs"),p=require("os").homedir()+"/.claude.json",dir=process.argv[1];',
  'let d;try{d=JSON.parse(fs.readFileSync(p,"utf8"))}catch{console.log("NOJSON");process.exit(2)}',
  'if(!d.projects)d.projects={};',
  'if(d.projects[dir]&&d.projects[dir].hasTrustDialogAccepted){console.log("TRUSTED");process.exit(0)}',
  'd.projects[dir]=Object.assign({},d.projects[dir],{hasTrustDialogAccepted:true});',
  'const tmp=p+".tmp."+process.pid;',
  'fs.writeFileSync(tmp,JSON.stringify(d,null,2));fs.renameSync(tmp,p);console.log("REGISTERED")',
].join('');

function ensureLocalClaudeTrust(projectPath: string): EnsureClaudeTrustResult {
  const configPath = join(homedir(), '.claude.json');
  if (!existsSync(configPath)) return { action: 'skipped', reason: '~/.claude.json not found' };

  let config: { projects?: Record<string, Record<string, unknown>> };
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (err) {
    return { action: 'failed', reason: `~/.claude.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }

  const existing = config.projects?.[projectPath];
  if (existing?.hasTrustDialogAccepted === true) return { action: 'already_trusted' };

  const updated = {
    ...config,
    projects: { ...config.projects, [projectPath]: { ...existing, hasTrustDialogAccepted: true } },
  };
  const tmpPath = `${configPath}.tmp.${process.pid}`;
  try {
    writeFileSync(tmpPath, JSON.stringify(updated, null, 2));
    renameSync(tmpPath, configPath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch {}
    return { action: 'failed', reason: `atomic write failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { action: 'registered' };
}

async function ensureRemoteClaudeTrust(
  transport: IServerTransport,
  projectPath: string,
): Promise<EnsureClaudeTrustResult> {
  const result = await transport.exec(
    `node -e ${shellQuote(REMOTE_SCRIPT)} ${shellQuote(projectPath)}`,
    REMOTE_TIMEOUT_MS,
  );
  const output = result.stdout;
  if (output.includes('REGISTERED')) return { action: 'registered' };
  if (output.includes('TRUSTED')) return { action: 'already_trusted' };
  if (output.includes('NOJSON')) return { action: 'skipped', reason: '~/.claude.json missing or invalid on remote' };
  return { action: 'failed', reason: `remote trust registration failed: ${output.trim() || result.stderr || `exit ${result.code}`}` };
}

export async function ensureClaudeTrust(
  serverType: string,
  transport: IServerTransport,
  projectPath: string,
): Promise<EnsureClaudeTrustResult> {
  if (serverType === 'local') return ensureLocalClaudeTrust(projectPath);
  return ensureRemoteClaudeTrust(transport, projectPath);
}
