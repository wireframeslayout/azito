// @vitest-environment jsdom
import { expect, it } from 'vitest';
import JSZip from 'jszip';
import { pptxToHtml } from '@jvmr/pptx-to-html';
import { preparePptx } from './preparePptx';

it('renders Japanese text across 20 slides after ZIP inspection', async () => {
  // jsdom's selector engine lacks the namespace wildcard supported by browsers.
  const query = Element.prototype.querySelector;
  Element.prototype.querySelector = function (selector: string) { return query.call(this, selector.replaceAll('*|', '')); };
  const zip = new JSZip();
  const ids: string[] = [], rels: string[] = [];
  for (let n = 1; n <= 20; n++) {
    ids.push(`<p:sldId id="${n + 255}" r:id="rId${n}"/>`);
    rels.push(`<Relationship Id="rId${n}" Target="slides/slide${n}.xml"/>`);
    zip.file(`ppt/slides/slide${n}.xml`, `<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>日本語 ${n}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`);
  }
  zip.file('ppt/presentation.xml', `<p:presentation xmlns:p="urn:p" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>${ids.join('')}</p:sldIdLst></p:presentation>`);
  zip.file('ppt/_rels/presentation.xml.rels', `<Relationships>${rels.join('')}</Relationships>`);
  const prepared = await preparePptx(await zip.generateAsync({ type: 'arraybuffer' }));
  const slides = await pptxToHtml(prepared.data);
  expect(slides).toHaveLength(20);
  expect(slides[0]).toContain('日本語 1');
  expect(slides[19]).toContain('日本語 20');
  Element.prototype.querySelector = query;
});
