import { describe, expect, it } from 'vitest';
import { taskStartsMisaoOf } from './misaoLocalWindows';
import { buildMisaoTaskXml, misaoWindowsLayout } from './misaoWindowsTask';
import { legacyMisaoTaskArgumentsOf } from '../../../shared/os/taskScheduler/misaoTaskArguments';
import { buildTaskXml } from '../../../shared/os/taskScheduler/taskDefinition';
import { windowsMisaoPipe } from '../../servers/transport/agentMisaoSocket';

const xmlFor = (rootOfTask: string): string => {
  const layout = misaoWindowsLayout({ misaoRoot: rootOfTask }, '0.3.0', 'AzitoMisao');
  return buildMisaoTaskXml({ userId: 'PC\\dev', systemRoot: 'C:\\Windows', homeDir: 'C:\\Users\\dev', layout, pipe: windowsMisaoPipe(rootOfTask, 'dev') });
};

describe('taskStartsMisaoOf', () => {
  it('finds the folder in legacy and new launchers including apostrophes', () => {
    const root = "C:\\Users\\O'Neil\\.azito\\misao";
    const pipe = windowsMisaoPipe(root, 'dev');
    const layout = misaoWindowsLayout({ misaoRoot: root }, '0.3.0', 'AzitoMisao');
    const legacy = buildTaskXml({ userId: 'PC\\dev', description: 'misao', executable: 'C:\\Windows\\System32\\conhost.exe', argumentsLine: legacyMisaoTaskArgumentsOf({ systemRoot: 'C:\\Windows', exe: layout.exe, root, logFile: layout.logFile, pipe }), workingDirectory: 'C:\\Users', restartOnFailure: { intervalMinutes: 1, count: 999 } });
    expect(taskStartsMisaoOf(legacy, root)).toBe(true);
    expect(taskStartsMisaoOf(xmlFor(root), root)).toBe(true);
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
