import { inspectOfficeZip } from './officeZip';

function columnNumber(reference: string): number {
  const letters = /^[A-Za-z]+/.exec(reference)?.[0];
  if (!letters) return 0;
  return [...letters.toUpperCase()].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0);
}
export async function prepareXlsx(data: ArrayBuffer): Promise<{ data: ArrayBuffer; truncated: boolean; losses: string[]; values: Record<string, Record<string, number | boolean>> }> {
  const zip = await inspectOfficeZip(data);
  const paths = Object.keys(zip.files);
  const values: Record<string, Record<string, number | boolean>> = {};
  const workbook = zip.file('xl/workbook.xml');
  const relationships = zip.file('xl/_rels/workbook.xml.rels');
  if (!workbook || !relationships) throw new Error('Invalid workbook');
  const workbookXml = new DOMParser().parseFromString(await workbook.async('string'), 'application/xml');
  const relationsXml = new DOMParser().parseFromString(await relationships.async('string'), 'application/xml');
  if (workbookXml.querySelector('parsererror') || relationsXml.querySelector('parsererror')) throw new Error('Invalid workbook XML');
  const rels = new Map(Array.from(relationsXml.getElementsByTagNameNS('*', 'Relationship')).map((rel) => [rel.getAttribute('Id'), rel.getAttribute('Target')]));
  const sheetNames = new Map<string, string>();
  for (const sheet of Array.from(workbookXml.getElementsByTagNameNS('*', 'sheet'))) {
    const name = sheet.getAttribute('name');
    const target = rels.get(sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id'));
    if (!name || !target || !/^(?:\/xl\/|xl\/|)worksheets\/[^/]+\.xml$/.test(target)) throw new Error('Invalid worksheet relationship');
    sheetNames.set(target.replace(/^\/?xl\//, '').replace(/^/, 'xl/'), name);
  }
  const losses = [
    paths.some((path) => path.startsWith('xl/drawings/')) && 'drawings',
    paths.some((path) => path.startsWith('xl/pivotTables/')) && 'pivotTables',
    paths.some((path) => path.startsWith('xl/charts/')) && 'charts',
  ].filter((value): value is string => typeof value === 'string');
  let truncated = false;
  for (const path of paths.filter((name) => /^xl\/drawings\/[^/]+\.xml$/.test(name))) {
    const file = zip.file(path);
    if (!file) continue;
    const doc = new DOMParser().parseFromString(await file.async('string'), 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('Invalid drawing');
    for (const name of ['row', 'col']) for (const coordinate of Array.from(doc.getElementsByTagNameNS('*', name))) {
      const value = Number(coordinate.textContent);
      if (!Number.isSafeInteger(value) || value < 0 || value >= (name === 'row' ? 5000 : 100)) throw new Error('Drawing exceeds the preview limit');
    }
  }
  for (const path of paths.filter((name) => /^xl\/worksheets\/[^/]+\.xml$/.test(name))) {
    const file = zip.file(path);
    if (!file) continue;
    const doc = new DOMParser().parseFromString(await file.async('string'), 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('Invalid worksheet');
    for (const col of Array.from(doc.getElementsByTagNameNS('*', 'col'))) {
      const min = Number(col.getAttribute('min'));
      const max = Number(col.getAttribute('max'));
      if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 1 || max < min) throw new Error('Invalid worksheet columns');
      if (min > 100) { col.remove(); truncated = true; }
      else if (max > 100) { col.setAttribute('max', '100'); truncated = true; }
    }
    for (const row of Array.from(doc.getElementsByTagNameNS('*', 'row'))) {
      const index = Number(row.getAttribute('r'));
      if (!Number.isSafeInteger(index) || index < 1) throw new Error('Invalid worksheet row');
      if (index > 5000) { row.remove(); truncated = true; continue; }
      for (const cell of Array.from(row.getElementsByTagNameNS('*', 'c'))) {
        const reference = cell.getAttribute('r') || '';
        const column = columnNumber(reference);
        const cellRow = Number(/\d+$/.exec(reference)?.[0]);
        if (!column || !Number.isSafeInteger(cellRow) || cellRow < 1 || cellRow !== index) throw new Error('Invalid worksheet cell');
        if (column > 100) { cell.remove(); truncated = true; }
        else {
          const type = cell.getAttribute('t');
          const raw = cell.getElementsByTagNameNS('*', 'v')[0]?.textContent;
          const name = sheetNames.get(path);
          if (name && raw != null && (type === null || type === 'n' || type === 'b')) {
            const value = Number(raw);
            if (Number.isFinite(value)) (values[name] ??= {})[`${index - 1}:${column - 1}`] = type === 'b' ? value !== 0 : value;
          }
        }
      }
    }
    if (truncated) zip.file(path, new XMLSerializer().serializeToString(doc));
  }
  return { data: truncated ? await zip.generateAsync({ type: 'arraybuffer' }) : data, truncated, losses, values };
}
