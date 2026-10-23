import { describe, expect, it } from 'vitest';
import { taskXmlNamesRoot } from './misaoLocalWindows';

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
});
