import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { taskMisaoRoot, taskStartsMisaoOf } from './misaoLocalWindows';
import { buildMisaoTaskXml, misaoWindowsLayout } from './misaoWindowsTask';
import { legacyMisaoTaskArgumentsOf } from '../../../shared/os/taskScheduler/misaoTaskArguments';
import { buildTaskXml } from '../../../shared/os/taskScheduler/taskDefinition';
import { windowsMisaoPipe } from '../../servers/transport/agentMisaoSocket';

const xmlFor = (rootOfTask: string): string => {
  const layout = misaoWindowsLayout({ misaoRoot: rootOfTask }, '0.3.0', 'AzitoMisao');
  return buildMisaoTaskXml({ userId: 'PC\\dev', systemRoot: 'C:\\Windows', homeDir: 'C:\\Users\\dev', layout, pipe: windowsMisaoPipe(rootOfTask, 'dev') });
};

describe('taskMisaoRoot', () => {
  it.each(['C:\\Users\\dev\\.azito\\misao', 'C:\\Users\\Foo Bar (Work)\\.azito\\misao', "C:\\Users\\O'Neil\\misao", 'C:\\Users\\A&B\\misao'])('reads %s from a generated task', (root) => {
    expect(taskMisaoRoot(xmlFor(root))).toBe(root);
  });
  it('returns undefined for an unreadable definition', () => {
    expect(taskMisaoRoot('<Task><Arguments>--headless whatever.exe</Arguments></Task>')).toBeUndefined();
  });
});

describe('taskStartsMisaoOf', () => {
  it('finds the folder in legacy and new launchers including apostrophes', () => {
    const root = "C:\\Users\\O'Neil’s\\.azito\\misao";
    const pipe = windowsMisaoPipe(root, 'dev');
    const layout = misaoWindowsLayout({ misaoRoot: root }, '0.3.0', 'AzitoMisao');
    const legacy = buildTaskXml({ userId: 'PC\\dev', description: 'misao', executable: 'C:\\Windows\\System32\\conhost.exe', argumentsLine: legacyMisaoTaskArgumentsOf({ systemRoot: 'C:\\Windows', exe: layout.exe, root, logFile: layout.logFile, pipe }), workingDirectory: 'C:\\Users', restartOnFailure: { intervalMinutes: 1, count: 999 } });
    expect(taskStartsMisaoOf(legacy, root)).toBe(true);
    expect(taskStartsMisaoOf(xmlFor(root), root)).toBe(true);
  });

  it('recognises the same folder through an alias before and after creation', () => {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'azo-')));
    try {
      const real = path.join(dir, 'real');
      fs.mkdirSync(real);
      const alias = path.join(dir, 'alias');
      fs.symlinkSync(real, alias, 'dir');
      const root = path.join(real, 'misao');
      expect(taskStartsMisaoOf(xmlFor(path.join(alias, 'misao')), root)).toBe(true);
      fs.mkdirSync(root);
      expect(taskStartsMisaoOf(xmlFor(path.join(alias, 'misao')), root)).toBe(true);
      expect(taskStartsMisaoOf(xmlFor(`${root}2`), root)).toBe(false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('accepts the generated task and rejects extra actions or another installation', () => {
    const root = 'C:\\Users\\dev\\.azito\\misao';
    const matches = (xml: string): boolean => taskStartsMisaoOf(xml, root);
    const xml = xmlFor(root);
    expect(matches(xml)).toBe(true);
    expect(matches(xml.replace('</Exec>', '</Exec><Exec><Command>C:\\other.exe</Command></Exec>'))).toBe(false);
    expect(matches(xmlFor(`${root}2`))).toBe(false);
    expect(matches('<Task/>')).toBe(false);
  });
});
