import { describe, expect, it } from 'vitest';
import { taskStartsMisaoOf } from './misaoLocalWindows';
import { buildMisaoTaskXml, misaoWindowsLayout } from './misaoWindowsTask';
import { windowsMisaoPipe } from '../../servers/transport/agentMisaoSocket';

const xmlFor = (rootOfTask: string): string => {
  const layout = misaoWindowsLayout({ misaoRoot: rootOfTask }, '0.3.0', 'AzitoMisao');
  return buildMisaoTaskXml({ userId: 'PC\\dev', systemRoot: 'C:\\Windows', homeDir: 'C:\\Users\\dev', layout, pipe: windowsMisaoPipe(rootOfTask, 'dev') });
};

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
