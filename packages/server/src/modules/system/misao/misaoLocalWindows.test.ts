import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { taskMisaoRoot, taskStartsMisaoOf } from './misaoLocalWindows';
import { buildMisaoTaskXml, misaoWindowsLayout } from './misaoWindowsTask';
import { windowsMisaoPipe } from '../../servers/transport/agentMisaoSocket';

const xmlFor = (rootOfTask: string): string => {
  const layout = misaoWindowsLayout({ misaoRoot: rootOfTask }, '0.3.0', 'AzitoMisao');
  return buildMisaoTaskXml({ userId: 'PC\\dev', systemRoot: 'C:\\Windows', homeDir: 'C:\\Users\\dev', layout, pipe: windowsMisaoPipe(rootOfTask, 'dev') });
};

describe('taskMisaoRoot', () => {
  it.each(['C:\\Users\\dev\\.azito\\misao', 'C:\\Users\\Foo Bar (Work)\\.azito\\misao', "C:\\Users\\O'Neil\\misao", 'C:\\Users\\A&B\\misao'])('reads %s back from the task the builder writes (plain command line or launcher script)', (root) => {
    expect(taskMisaoRoot(xmlFor(root))).toBe(root);
  });

  it('is undefined for a definition that is not a misao task of this code', () => {
    expect(taskMisaoRoot('<Task><Arguments>--headless whatever.exe</Arguments></Task>')).toBeUndefined();
  });

  it('compares the folder itself, not text that happens to contain it', () => {
    expect(taskMisaoRoot('<Arguments>--data "D:\\other" &gt;&gt; "C:\\Users\\dev\\misao\\misao.log"</Arguments>')).toBe('D:\\other');
  });
});

describe('taskStartsMisaoOf', () => {
  let dir: string;
  beforeEach(() => { dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'azo-'))); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('says yes for the same folder spelled through a link (a short name on Windows), before and after the folder exists, and no for a sibling or another folder', () => {
    const real = path.join(dir, 'real');
    fs.mkdirSync(real);
    const alias = path.join(dir, 'alias');
    fs.symlinkSync(real, alias, 'dir');
    const root = path.join(real, 'misao');
    // The task was written with the alias spelling (as an agent that reported a short name would have it), the hub's root is the real one.
    expect(taskStartsMisaoOf(xmlFor(path.join(alias, 'misao')), root)).toBe(true);
    fs.mkdirSync(root);
    expect(taskStartsMisaoOf(xmlFor(path.join(alias, 'misao')), root)).toBe(true);
    expect(taskStartsMisaoOf(xmlFor(`${root}2`), root)).toBe(false);
    expect(taskStartsMisaoOf(xmlFor(path.join(dir, 'else', 'misao')), root)).toBe(false);
    expect(taskStartsMisaoOf('<Task/>', root)).toBe(false);
  });
});
