// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { preparePptx } from './preparePptx';

async function presentation(count: number): Promise<ArrayBuffer> {
  const zip = new JSZip();
  const ids: string[] = [];
  const rels: string[] = [];
  for (let n = 1; n <= count; n++) {
    ids.push(`<p:sldId id="${n + 255}" r:id="rId${n}"/>`);
    rels.push(`<Relationship Id="rId${n}" Target="slides/slide${n}.xml"/>`);
    zip.file(`ppt/slides/slide${n}.xml`, '<slide/>');
    zip.file(`ppt/slides/_rels/slide${n}.xml.rels`, '<Relationships/>');
  }
  zip.file('ppt/presentation.xml', `<p:presentation xmlns:p="urn:p" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>${ids.join('')}</p:sldIdLst></p:presentation>`);
  zip.file('ppt/_rels/presentation.xml.rels', `<Relationships>${rels.join('')}</Relationships>`);
  return zip.generateAsync({ type: 'arraybuffer' });
}

describe('preparePptx', () => {
  it('leaves short presentations intact', async () => {
    expect((await preparePptx(await presentation(2))).truncated).toBe(false);
  });
  it('removes slides after the first 50 and their relationships', async () => {
    const result = await preparePptx(await presentation(52));
    expect(result.truncated).toBe(true);
    const zip = await JSZip.loadAsync(result.data);
    expect(zip.file('ppt/slides/slide50.xml')).not.toBeNull();
    expect(zip.file('ppt/slides/slide51.xml')).toBeNull();
    expect(zip.file('ppt/slides/_rels/slide51.xml.rels')).toBeNull();
    expect(await zip.file('ppt/presentation.xml')!.async('string')).not.toContain('rId51');
    expect(await zip.file('ppt/_rels/presentation.xml.rels')!.async('string')).not.toContain('rId51');
  });
});
