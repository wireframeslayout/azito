import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCommandSpec } from '../../exec/commandSpec';
import { fakeRunTransport, failed, ok, specText } from '../../exec/testing/commandTesting';
import { SchtasksClient, SchtasksError, parseCsvRecords, type CommandSpecRunner, rawRunnerOf } from './schtasks';
import { rawFromText } from './testing/liveTask';
import { decodeTaskXml } from './taskDefinition';

const SCHTASKS = 'C:\\Windows\\System32\\schtasks.exe';

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-schtasks-test-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** A `/Query /TN <name> /FO CSV /NH /V` row (columns up to "Last Result"; the Status text is Japanese on purpose). */
function verboseRow(name: string, lastResult: string): string {
  return `"PC","\\${name}","N/A","実行中","Interactive only","2026/10/23 10:00:00","${lastResult}","me","C:\\x.exe","C:\\"\r\n`;
}

function client(respond?: Parameters<typeof fakeRunTransport>[0]): { client: SchtasksClient; specs: ReturnType<typeof fakeRunTransport>['specs'] } {
  const transport = fakeRunTransport(respond);
  return { client: new SchtasksClient(rawFromText(transport.run), { systemRoot: 'C:\\Windows', tmpDir }), specs: transport.specs };
}

describe('SchtasksClient', () => {
  it('needs %SystemRoot% (no PATH lookup of schtasks.exe)', () => {
    expect(() => new SchtasksClient(rawFromText(fakeRunTransport().run), { systemRoot: undefined, tmpDir })).toThrow(/SystemRoot/);
  });

  it('registers from an XML file that is already on the host the runner executes on, without a temporary directory of its own', async () => {
    const transport = fakeRunTransport();
    const c = new SchtasksClient(rawFromText(transport.run), { systemRoot: 'C:\\Windows' });
    await c.registerFromFile('AzitoTest', 'C:\\Users\\a b\\task.xml');
    expect(transport.specs[0]!.args).toEqual(['/Create', '/XML', 'C:\\Users\\a b\\task.xml', '/TN', 'AzitoTest', '/F']);
    await expect(c.register('AzitoTest', '<Task/>')).rejects.toThrow(/no temporary directory/);
    await expect(c.registerFromFile('bad name', 'C:\\x.xml')).rejects.toThrow(/Invalid task name/);
  });

  it('rejects a task name that is not plain ASCII (schtasks speaks the OEM code page)', async () => {
    const { client: c, specs } = client();
    await expect(c.start('日本語')).rejects.toThrow(/Invalid task name/);
    await expect(c.start('a b')).rejects.toThrow(/Invalid task name/);
    await expect(c.stop('..\\x')).rejects.toThrow(/Invalid task name/);
    expect(specs).toEqual([]);
  });

  it('registers from a UTF-16 XML file in a private temp directory, and removes it afterwards', async () => {
    let xmlFile = '';
    let seen = '';
    const { client: c, specs } = client((spec) => {
      xmlFile = spec.args[2]!;
      seen = decodeTaskXml(fs.readFileSync(xmlFile));
      return ok();
    });
    await c.register('AzitoTest', '<Task>日本語</Task>');
    expect(specs).toHaveLength(1);
    expect(specs[0]!.file).toBe(SCHTASKS);
    expect(specs[0]!.args).toEqual(['/Create', '/XML', xmlFile, '/TN', 'AzitoTest', '/F']);
    expect(seen).toBe('<Task>日本語</Task>');
    expect(fs.existsSync(xmlFile)).toBe(false);
    expect(fs.existsSync(path.dirname(xmlFile))).toBe(false);
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  it('removes the temp file when schtasks fails, and the error carries the operation, exit code and stderr', async () => {
    const { client: c } = client(() => failed(1, 'ERROR: Access is denied.'));
    const err = await c.register('AzitoTest', '<Task/>').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SchtasksError);
    expect(err).toMatchObject({ operation: 'create', taskName: 'AzitoTest', exitCode: 1, detail: 'ERROR: Access is denied.' });
    expect((err as Error).message).toBe('schtasks /create of the task "AzitoTest" failed (exit 1): ERROR: Access is denied.');
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  it.each([
    ['start', ['/Run', '/TN', 'AzitoTest'], 'run'],
    ['stop', ['/End', '/TN', 'AzitoTest'], 'end'],
    ['delete', ['/Delete', '/TN', 'AzitoTest', '/F'], 'delete'],
  ] as const)('%s runs the schtasks verb and maps a failure to an error', async (method, args, operation) => {
    const ok1 = client();
    await ok1.client[method]('AzitoTest');
    expect(ok1.specs.map((s) => [s.file, ...s.args])).toEqual([[SCHTASKS, ...args]]);

    const bad = client(() => failed(1, '', 'ERROR: The system cannot find the file specified.'));
    await expect(bad.client[method]('AzitoTest')).rejects.toMatchObject({ operation, exitCode: 1, detail: 'ERROR: The system cannot find the file specified.' });
  });

  describe('query', () => {
    it('reads the numeric last result by column, not the translated Status', async () => {
      const running = client(() => ok(verboseRow('AzitoTest', '267009')));
      expect(await running.client.query('AzitoTest')).toEqual({ exists: true, running: true, failed: false, lastResult: 267009 });
      expect(specText(running.specs[0]!)).toBe(`${SCHTASKS} /Query /TN AzitoTest /FO CSV /NH /V`);

      const done = client(() => ok(verboseRow('AzitoTest', '0')));
      expect(await done.client.query('AzitoTest')).toEqual({ exists: true, running: false, failed: false, lastResult: 0 });
    });

    it.each([['267011', false], ['267014', false], ['1', true], ['-2147020576', true]])('last result %s: failed=%s', async (lastResult, isFailed) => {
      const { client: c } = client(() => ok(verboseRow('AzitoTest', lastResult)));
      expect(await c.query('AzitoTest')).toMatchObject({ exists: true, running: false, failed: isFailed });
    });

    it('matches the task name without regard to case (Task Scheduler names are case-insensitive)', async () => {
      const found = client(() => ok(verboseRow('AzitoHub', '0')));
      expect(await found.client.query('azitohub')).toMatchObject({ exists: true, lastResult: 0 });
      const listed = client((spec) => (spec.args.includes('/TN') ? failed(1, 'denied') : ok('"\\AzitoHub","N/A","Ready"\r\n')));
      await expect(listed.client.query('AZITOHUB')).rejects.toMatchObject({ operation: 'query' });
    });

    it('skips rows of other tasks and takes the one by name', async () => {
      const { client: c } = client(() => ok(verboseRow('Other', '1') + verboseRow('AzitoTest', '0')));
      expect(await c.query('AzitoTest')).toMatchObject({ lastResult: 0 });
    });

    it('is a missing task when the query fails and the task list does not name it (no message matching)', async () => {
      const { client: c, specs } = client((spec) => (spec.args.includes('/TN') ? failed(1, 'エラー: 指定されたファイルが見つかりません。') : ok('"\\Other","N/A","Ready"\r\n')));
      expect(await c.query('AzitoTest')).toEqual({ exists: false });
      expect(specs.map((s) => s.args)).toEqual([['/Query', '/TN', 'AzitoTest', '/FO', 'CSV', '/NH', '/V'], ['/Query', '/FO', 'CSV', '/NH']]);
    });

    it('is an error, not "missing", when the query fails but the task is listed (access denied)', async () => {
      const { client: c } = client((spec) => (spec.args.includes('/TN') ? failed(1, 'ERROR: Access is denied.') : ok('"\\AzitoTest","N/A","Ready"\r\n')));
      await expect(c.query('AzitoTest')).rejects.toMatchObject({ operation: 'query', exitCode: 1, detail: 'ERROR: Access is denied.' });
    });

    it('refuses output it cannot read instead of guessing a state', async () => {
      const { client: c } = client(() => ok('"PC","\\AzitoTest","N/A","Ready","x","y","not a number"\r\n'));
      await expect(c.query('AzitoTest')).rejects.toThrow(/last result/);
    });
  });
});

/** A runner that answers by command: `reg` with the OEM code page, schtasks with the given bytes. */
function oemClient(codePage: number | 'unreadable', stderr: Buffer): { client: SchtasksClient; regCalls: () => number } {
  let regCalls = 0;
  const run: CommandSpecRunner = async (spec) => {
    if (spec.file.endsWith('reg.exe')) {
      regCalls++;
      if (codePage === 'unreadable') return { exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      return { exitCode: 0, stdout: Buffer.from(`\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage\r\n    OEMCP    REG_SZ    ${codePage}\r\n\r\n`), stderr: Buffer.alloc(0) };
    }
    return { exitCode: 1, stdout: Buffer.alloc(0), stderr };
  };
  return { client: new SchtasksClient(run, { systemRoot: 'C:\\Windows', tmpDir }), regCalls: () => regCalls };
}

// "エラー: 指定されたファイルが見つかりません。" in CP932.
const CP932_ERROR = Buffer.from('8347838981 5b3a20'.replace(' ', ''), 'hex');

describe('SchtasksClient output decoding (OEM code page)', () => {
  it('reads a CP932 error message, asking the registry once', async () => {
    const { client: c, regCalls } = oemClient(932, CP932_ERROR);
    const first = await c.start('AzitoTest').catch((e: unknown) => e);
    expect(first).toBeInstanceOf(SchtasksError);
    expect((first as SchtasksError).detail).toBe('エラー:');
    expect((first as SchtasksError).rawDetail).toEqual(CP932_ERROR);
    await c.stop('AzitoTest').catch(() => undefined);
    expect(regCalls()).toBe(1);
  });

  it('does not read the registry for ASCII output', async () => {
    const { client: c, regCalls } = oemClient(932, Buffer.from('ERROR: Access is denied.'));
    await expect(c.start('AzitoTest')).rejects.toMatchObject({ detail: 'ERROR: Access is denied.' });
    expect(regCalls()).toBe(0);
  });

  it('keeps the bytes, and says so, for a code page without a decoder (never UTF-8 by guess)', async () => {
    const { client: c } = oemClient(437, Buffer.from([0x82, 0x41]));
    const err = (await c.start('AzitoTest').catch((e: unknown) => e)) as SchtasksError;
    expect(err.detail).toBe('[undecodable output: the OEM code page 437 has no decoder; bytes 8241]');
    expect(err.rawDetail).toEqual(Buffer.from([0x82, 0x41]));
  });

  it('reads UTF-8 output when the OEM code page is 65001', async () => {
    const { client: c } = oemClient(65001, Buffer.from('エラー: 見つかりません。', 'utf-8'));
    await expect(c.start('AzitoTest')).rejects.toMatchObject({ detail: 'エラー: 見つかりません。' });
  });

  it('says so when the bytes are not valid in the code page', async () => {
    const { client: c } = oemClient(932, Buffer.from([0x81]));
    await expect(c.start('AzitoTest')).rejects.toMatchObject({ detail: expect.stringContaining('not valid shift_jis (OEM code page 932); bytes 81') });
  });

  it('keeps the original error when the code page cannot be read, with the cause, and tries again next time', async () => {
    const { client: c, regCalls } = oemClient('unreadable', CP932_ERROR);
    const err = await c.start('AzitoTest').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SchtasksError);
    expect(err).toMatchObject({ operation: 'run', taskName: 'AzitoTest', exitCode: 1, rawDetail: CP932_ERROR });
    expect((err as SchtasksError).detail).toContain('the OEM code page could not be read (Cannot read the OEM code page: reg query failed (exit 1))');
    expect((err as SchtasksError).detail).toContain('bytes 83478389815b3a20');
    await expect(c.start('AzitoTest')).rejects.toBeInstanceOf(SchtasksError);
    expect(regCalls()).toBe(2);
  });

  it('a runner that returns no raw bytes is an error, not a UTF-8 guess', async () => {
    const run = rawRunnerOf(async () => ({ exitCode: 0, signal: null, stdout: 'x', stderr: '' }));
    await expect(run(buildCommandSpec('x', []))).rejects.toThrow(/rawOutput/);
  });

  it('reads the task state from a CP932 Status column without the code page', async () => {
    const row = Buffer.concat([Buffer.from('"PC","\\AzitoTest","N/A","'), Buffer.from('8e c0 8d 73 92 86'.replace(/ /g, ''), 'hex'), Buffer.from('","x","N/A","267009"\r\n')]);
    const run: CommandSpecRunner = async () => ({ exitCode: 0, stdout: row, stderr: Buffer.alloc(0) });
    const c = new SchtasksClient(run, { systemRoot: 'C:\\Windows', tmpDir });
    expect(await c.query('AzitoTest')).toMatchObject({ exists: true, running: true });
  });
});

describe('parseCsvRecords', () => {
  it('reads quoted fields with commas, doubled quotes and line breaks', () => {
    expect(parseCsvRecords('"a,b","c ""d""","e\r\nf"\r\n"g","","h"\r\n')).toEqual([['a,b', 'c "d"', 'e\r\nf'], ['g', '', 'h']]);
  });

  it('keeps an empty final field and ignores blank lines', () => {
    expect(parseCsvRecords('"a",\r\n\r\n"b"')).toEqual([['a', ''], ['b']]);
  });

  it('refuses a quote that is never closed', () => {
    expect(() => parseCsvRecords('"a')).toThrow(/quoted field/);
  });
});
