import { describe, expect, it } from 'vitest';
import { windowsMisaoPipe } from '../../servers/transport/agentMisaoSocket';
import { buildMisaoTaskXml, misaoTaskArguments, misaoWindowsLayout, misaoWindowsReleasePaths } from './misaoWindowsTask';

const ROOT = 'C:\\Users\\dev\\.azito\\misao';
const PIPE = windowsMisaoPipe(ROOT, 'dev');
const layout = misaoWindowsLayout({ misaoRoot: ROOT }, '0.3.0', 'AzitoMisao');

describe('the Windows misao layout', () => {
  it('puts each release in its own folder under the misao folder, with no link', () => {
    expect(layout).toEqual({
      root: ROOT,
      versionDir: `${ROOT}\\0.3.0`,
      exe: `${ROOT}\\0.3.0\\misao.exe`,
      stageDir: `${ROOT}\\0.3.0.upload`,
      currentFile: `${ROOT}\\current`,
      logFile: `${ROOT}\\misao.log`,
      taskXmlFile: `${ROOT}\\AzitoMisao.task.xml`,
    });
  });

  it('lists the release files in the order of the manifest, the executable as misao.exe', () => {
    expect(misaoWindowsReleasePaths(layout.versionDir)).toEqual([`${ROOT}\\0.3.0\\misao.exe`, `${ROOT}\\0.3.0\\LICENSE`, `${ROOT}\\0.3.0\\NOTICE`, `${ROOT}\\0.3.0\\THIRD-PARTY-LICENSES.txt`]);
  });
});

describe('the misao task', () => {
  it('runs misao.exe under cmd.exe, which appends the log, headless, with the pipe and the folder named', () => {
    expect(misaoTaskArguments({ systemRoot: 'C:\\Windows', layout, pipe: PIPE }))
      .toBe(`--headless C:\\Windows\\System32\\cmd.exe /d /c ""${ROOT}\\0.3.0\\misao.exe" serve --socket "${PIPE}" --data "${ROOT}" >> "${ROOT}\\misao.log" 2>&1"`);
  });

  it('quotes a system folder with a space, and keeps a home folder with a space inside the cmd quotes', () => {
    const spaced = misaoWindowsLayout({ misaoRoot: 'C:\\Users\\Dev User\\.azito\\misao' }, '0.3.0', 'AzitoMisao');
    const line = misaoTaskArguments({ systemRoot: 'D:\\Win dows', layout: spaced, pipe: windowsMisaoPipe(spaced.root, 'Dev User') });
    expect(line.startsWith('--headless "D:\\Win dows\\System32\\cmd.exe" /d /c ""C:\\Users\\Dev User\\.azito\\misao\\0.3.0\\misao.exe" serve')).toBe(true);
  });

  it.each(['100%', 'a"b', 'a!b', 'a\nb'])('refuses a folder with %j instead of writing something cmd.exe would read differently', (name) => {
    const bad = misaoWindowsLayout({ misaoRoot: `C:\\Users\\${name}\\misao` }, '0.3.0', 'AzitoMisao');
    expect(() => misaoTaskArguments({ systemRoot: 'C:\\Windows', layout: bad, pipe: PIPE })).toThrow(/cannot be written to the misao task/);
  });

  it('starts at the user\'s logon, works in the home folder, and restarts after a failure', () => {
    const xml = buildMisaoTaskXml({ userId: 'PC\\dev', systemRoot: 'C:\\Windows', homeDir: 'C:\\Users\\dev', layout, pipe: PIPE });
    expect(xml).toContain('<LogonTrigger>');
    expect(xml).toContain('<UserId>PC\\dev</UserId>');
    expect(xml).toContain('<Command>C:\\Windows\\System32\\conhost.exe</Command>');
    expect(xml).toContain('<WorkingDirectory>C:\\Users\\dev</WorkingDirectory>');
    expect(xml).toContain('<RestartOnFailure>');
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>');
    // The redirects are XML-escaped in the element text.
    expect(xml).toContain('&gt;&gt; "C:\\Users\\dev\\.azito\\misao\\misao.log" 2&gt;&amp;1"</Arguments>');
  });
});
