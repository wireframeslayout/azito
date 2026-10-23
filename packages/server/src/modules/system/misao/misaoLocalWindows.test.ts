import { describe, expect, it } from 'vitest';
import { taskXmlNamesRoot } from './misaoLocalWindows';
import { buildMisaoTaskXml, misaoWindowsLayout } from './misaoWindowsTask';
import { windowsMisaoPipe } from '../../servers/transport/agentMisaoSocket';

describe('taskXmlNamesRoot', () => {
  const root = 'C:\\Users\\Foo Bar & Co\\.azito\\misao';

  it('finds the folder in the task\'s command line, with XML entities decoded and without regard to case', () => {
    const xml = '<Arguments>--headless cmd.exe /d /c ""C:\\USERS\\foo bar &amp; co\\.azito\\misao\\0.3.0\\misao.exe" serve"</Arguments>';
    expect(taskXmlNamesRoot(xml, root)).toBe(true);
  });

  it('does not take a sibling folder with the same beginning for the folder', () => {
    expect(taskXmlNamesRoot('<Arguments>"C:\\Users\\Foo Bar &amp; Co\\.azito\\misao2\\0.3.0\\misao.exe"</Arguments>', root)).toBe(false);
  });

  it('does not find another folder', () => {
    expect(taskXmlNamesRoot('<Arguments>"D:\\x\\misao\\0.3.0\\misao.exe"</Arguments>', root)).toBe(false);
  });

  it.each(['C:\\Users\\Foo Bar (Work)\\.azito\\misao', "C:\\Users\\O'Neil\\misao", 'C:\\Users\\dev\\.azito\\misao'])('finds %s in the task the builder writes for it (plain command line or launcher script), and not in the task of another folder', (misaoRoot) => {
    const xmlFor = (rootOfTask: string): string => {
      const layout = misaoWindowsLayout({ misaoRoot: rootOfTask }, '0.3.0', 'AzitoMisao');
      return buildMisaoTaskXml({ userId: 'PC\\dev', systemRoot: 'C:\\Windows', homeDir: 'C:\\Users\\dev', layout, pipe: windowsMisaoPipe(rootOfTask, 'dev') });
    };
    expect(taskXmlNamesRoot(xmlFor(misaoRoot), misaoRoot)).toBe(true);
    expect(taskXmlNamesRoot(xmlFor('D:\\other folder (x)\\misao'), misaoRoot)).toBe(false);
  });
});
