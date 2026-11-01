import { describe, expect, it } from 'vitest';
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
  it('accepts the generated task and rejects extra actions or another installation', () => {
    const root = 'C:\\Users\\dev\\.azito\\misao';
    const matches = (xml: string): boolean => taskStartsMisaoOf(xml, root, 'C:\\Windows', windowsMisaoPipe(root, 'dev'), 'AzitoMisao');
    const xml = xmlFor(root);
    expect(matches(xml)).toBe(true);
    expect(matches(xml.replace('</Exec>', '</Exec><Exec><Command>C:\\other.exe</Command></Exec>'))).toBe(false);
    expect(matches(xmlFor(`${root}2`))).toBe(false);
    expect(matches('<Task/>')).toBe(false);
  });
});
