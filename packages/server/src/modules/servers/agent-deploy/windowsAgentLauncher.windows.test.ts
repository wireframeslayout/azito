import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { powershellEncodedArgs } from '../../../shared/os/shellDialect';
import { agentLauncherScript } from './windowsAgentTask';

describe.skipIf(process.platform !== 'win32')('Windows agent launcher', () => {
  it('retries a failed agent and stops after a clean exit', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent O'Neil (test) "));
    try {
      const count = path.join(dir, 'count');
      const entry = path.join(dir, 'agent.cjs');
      const env = path.join(dir, 'agent.env');
      fs.writeFileSync(env, '');
      fs.writeFileSync(entry, `const fs = require('fs'); const f = ${JSON.stringify(count)}; const n = fs.existsSync(f) ? +fs.readFileSync(f, 'utf8') + 1 : 1; fs.writeFileSync(f, String(n)); process.exit(n === 1 ? 3 : 0);`);
      const powershell = path.join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const result = spawnSync(powershell, powershellEncodedArgs(`function Get-ScheduledTask { return @{ Settings = @{ Enabled = $true } } }\n${agentLauncherScript(process.execPath, env, entry, 'AzitoAgent')}`), { encoding: 'utf8', timeout: 60_000 });
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(fs.readFileSync(count, 'utf8')).toBe('2');
      expect(fs.readFileSync(path.join(dir, 'agent.log'), 'utf8')).toContain('retry in 5 seconds');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);

  it('does not start an agent when its task is disabled', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-disabled-'));
    try {
      const entry = path.join(dir, 'agent.cjs');
      const env = path.join(dir, 'agent.env');
      const count = path.join(dir, 'count');
      fs.writeFileSync(env, '');
      fs.writeFileSync(entry, `require('fs').writeFileSync(${JSON.stringify(count)}, 'started')`);
      const powershell = path.join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const script = `function Get-ScheduledTask { return @{ Settings = @{ Enabled = $false } } }\n${agentLauncherScript(process.execPath, env, entry, 'AzitoAgent')}`;
      const result = spawnSync(powershell, powershellEncodedArgs(script), { encoding: 'utf8', timeout: 30_000 });
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(fs.existsSync(count)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('ends the agent after the launcher parent disappears', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-parent-'));
    let launcherPid = 0;
    try {
      const entry = path.join(dir, 'agent.cjs');
      const env = path.join(dir, 'agent.env');
      const childPid = path.join(dir, 'child.pid');
      fs.writeFileSync(env, '');
      fs.writeFileSync(entry, `require('fs').writeFileSync(${JSON.stringify(childPid)}, String(process.pid)); setInterval(() => {}, 1000);`);
      const powershell = path.join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const script = `function Get-ScheduledTask { return @{ Settings = @{ Enabled = $true } } }\n${agentLauncherScript(process.execPath, env, entry, 'AzitoAgent')}`;
      const args = powershellEncodedArgs(script);
      const parent = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', '$p = Start-Process -FilePath $env:TEST_PS -ArgumentList (ConvertFrom-Json $env:TEST_ARGS) -PassThru -WindowStyle Hidden; $p.Id; Start-Sleep -Seconds 8'], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, TEST_PS: powershell, TEST_ARGS: JSON.stringify(args) } });
      launcherPid = Number(parent.stdout.trim());
      expect(launcherPid).toBeGreaterThan(0);
      expect(fs.existsSync(childPid)).toBe(true);
      const pid = Number(fs.readFileSync(childPid, 'utf8'));
      const probe = spawnSync(powershell, ['-NoProfile', '-Command', `for ($i = 0; $i -lt 30; $i++) { if (-not (Get-Process -Id ${pid} -ErrorAction SilentlyContinue)) { exit 0 }; Start-Sleep -Seconds 1 }; exit 1`], { timeout: 40_000 });
      expect(probe.status).toBe(0);
    } finally {
      if (launcherPid) spawnSync('taskkill', ['/PID', String(launcherPid), '/T', '/F']);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});
