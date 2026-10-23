import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeRunTransport, failed, ok, specText } from '../../exec/testing/commandTesting';
import { SchtasksClient, SchtasksError, parseCsvRecords } from './schtasks';
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
  return { client: new SchtasksClient(transport.run, { systemRoot: 'C:\\Windows', tmpDir }), specs: transport.specs };
}

describe('SchtasksClient', () => {
  it('needs %SystemRoot% (no PATH lookup of schtasks.exe)', () => {
    expect(() => new SchtasksClient(fakeRunTransport().run, { systemRoot: undefined, tmpDir })).toThrow(/SystemRoot/);
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
