import { inspectOfficeZip } from './officeZip';

const SLIDE_LIMIT = 50;
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function parseXml(text: string): XMLDocument {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Invalid presentation XML');
  return doc;
}

function slidePath(target: string): string {
  const parts: string[] = target.startsWith('/') ? [] : ['ppt'];
  for (const part of target.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  const path = parts.join('/');
  if (!/^ppt\/slides\/slide\d+\.xml$/.test(path)) throw new Error('Invalid slide relationship');
  return path;
}

export async function preparePptx(data: ArrayBuffer): Promise<{ data: ArrayBuffer; truncated: boolean }> {
  const zip = await inspectOfficeZip(data);
  for (const path of Object.keys(zip.files).filter((name) => /^ppt\/charts\/[^/]+\.xml$/.test(name))) {
    const file = zip.file(path);
    if (!file) continue;
    const chart = parseXml(await file.async('string'));
    for (const point of Array.from(chart.getElementsByTagNameNS('*', 'pt'))) {
      const index = Number(point.getAttribute('idx'));
      if (!Number.isSafeInteger(index) || index < 0 || index > 5000) throw new Error('Chart exceeds the preview limit');
    }
  }
  const presentation = zip.file('ppt/presentation.xml');
  const relations = zip.file('ppt/_rels/presentation.xml.rels');
  if (!presentation || !relations) throw new Error('Invalid presentation');
  const doc = parseXml(await presentation.async('string'));
  const rels = parseXml(await relations.async('string'));
  const ids = Array.from(doc.getElementsByTagNameNS('*', 'sldId'));
  const byId = new Map(Array.from(rels.getElementsByTagNameNS('*', 'Relationship')).map((el) => [el.getAttribute('Id'), el]));
  const paths = ids.map((id) => {
    const relation = byId.get(id.getAttributeNS(REL_NS, 'id'));
    const target = relation?.getAttribute('Target');
    if (!target || relation?.getAttribute('TargetMode') === 'External') throw new Error('Invalid slide relationship');
    const path = slidePath(target);
    if (!zip.file(path)) throw new Error('Missing slide');
    return path;
  });
  if (new Set(paths).size !== paths.length) throw new Error('Duplicate slide relationship');
  if (ids.length === 0 && Object.keys(zip.files).some((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))) throw new Error('Missing slide list');
  if (ids.length <= SLIDE_LIMIT) return { data, truncated: false };
  const kept = new Set(ids.slice(0, SLIDE_LIMIT).map((id) => id.getAttributeNS(REL_NS, 'id')));
  for (const id of ids.slice(SLIDE_LIMIT)) {
    const relId = id.getAttributeNS(REL_NS, 'id');
    const relation = byId.get(relId);
    const target = relation?.getAttribute('Target');
    if (!relId || !relation || !target || kept.has(relId)) throw new Error('Invalid slide relationship');
    const path = slidePath(target);
    zip.remove(path);
    zip.remove(path.replace('slides/', 'slides/_rels/') + '.rels');
    relation.remove();
    id.remove();
  }
  const serialize = new XMLSerializer();
  zip.file('ppt/presentation.xml', serialize.serializeToString(doc));
  zip.file('ppt/_rels/presentation.xml.rels', serialize.serializeToString(rels));
  return { data: await zip.generateAsync({ type: 'arraybuffer' }), truncated: true };
}
