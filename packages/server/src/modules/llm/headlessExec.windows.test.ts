import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { probeLookoutLlm } from '../lookout/lookoutLlm';
import { runHeadlessCommand } from './headlessExec';

describe.skipIf(process.platform !== 'win32')('Windows npm shim', () => {
  it('passes version, authentication, stdin and arguments through a shim', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'azito shim '));
    const oldPath = process.env.PATH;
    const oldExt = process.env.PATHEXT;
    try {
      writeFileSync(join(dir, 'test.js'), 'let input="";process.stdin.on("data",x=>input+=x);process.stdin.on("end",()=>{console.log(JSON.stringify({args:process.argv.slice(2),input}));if(process.argv.includes("hang")){setInterval(()=>{},1000);return}process.exit(process.argv.includes("fail")?3:0)})');
      // npm shims normally locate node beside themselves, or fall back to PATH.
      writeFileSync(join(dir, 'codex.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0test.js" %*\r\n`);
      process.env.PATH = dir; process.env.PATHEXT = '.CMD';
      for (const args of [['--version'], ['login', 'status'], ['exec', '-m', 'model', '-o', 'file name', '-']]) {
        const result = JSON.parse(await runHeadlessCommand('codex', args, dir, 'prompt'));
        expect(result).toEqual({ args, input: 'prompt' });
      }
      await expect(runHeadlessCommand('codex', ['fail'], dir, '')).rejects.toMatchObject({ reason: 'failed' });
      await expect(runHeadlessCommand('codex', ['secret&value'], dir, '')).rejects.toMatchObject({ reason: 'failed', detail: 'unsafe_argument' });
      await expect(runHeadlessCommand('codex', ['hang'], dir, '', 500)).rejects.toMatchObject({ reason: 'timeout' });
      const probe = await probeLookoutLlm({ enabled: true, provider: 'claude', model: 'haiku', updatedAt: '' });
      expect(probe).toMatchObject({ reason: 'cli_not_found', search: { directories: [dir], extensions: ['.CMD'] } });
    } finally { process.env.PATH = oldPath; process.env.PATHEXT = oldExt; rmSync(dir, { recursive: true, force: true }); }
  });
});
