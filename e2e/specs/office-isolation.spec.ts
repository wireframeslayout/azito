import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { test, expect } from '../fixtures/test';

async function makeDocx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:v="urn:schemas-microsoft-com:vml"><w:body><w:p><w:r><w:t>DOCX sample</w:t><w:pict><v:shape><v:imagedata src="https://external.invalid/image.png"/></v:shape></w:pict></w:r></w:p></w:body></w:document>');
  return zip.generateAsync({ type: 'nodebuffer' });
}
async function makePptx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('ppt/presentation.xml', '<p:presentation xmlns:p="urn:p" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="r1"/></p:sldIdLst></p:presentation>');
  zip.file('ppt/_rels/presentation.xml.rels', '<Relationships><Relationship Id="r1" Target="slides/slide1.xml"/></Relationships>');
  zip.file('ppt/slides/slide1.xml', '<p:sld xmlns:p="urn:p" xmlns:a="urn:a" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>日本語 slide</a:t></a:r></a:p></p:txBody></p:sp><p:pic><p:blipFill><a:blip r:link="external"/></p:blipFill></p:pic></p:spTree></p:cSld></p:sld>');
  zip.file('ppt/slides/_rels/slide1.xml.rels', '<Relationships><Relationship Id="external" Target="https://external.invalid/image.png" TargetMode="External" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"/></Relationships>');
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('Office previews do not request external resources', async ({ app, harness }) => {
  const dir = path.join(harness.rootDir, 'office-fixtures');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'sample.docx'), await makeDocx());
  fs.writeFileSync(path.join(dir, 'sample.pptx'), await makePptx());
  const project = await harness.createProject('office-preview');
  await harness.api(`/projects/${project}/servers/local`, { method: 'PUT', body: JSON.stringify({ working_directory: dir }) });
  const requests: string[] = [];
  app.on('request', (request) => { if (request.url().includes('external.invalid')) requests.push(request.url()); });
  await app.goto(`${harness.baseUrl}/workspace/${project}`);
  await app.getByTitle('ファイル', { exact: true }).click();
  await app.getByText('sample.docx', { exact: true }).click();
  await expect(app.frameLocator('iframe[title="文書プレビュー"]').getByText('DOCX sample')).toBeVisible();
  await app.getByText('sample.pptx', { exact: true }).click();
  await expect(app.frameLocator('iframe[title="スライド 1"]').getByText('日本語 slide')).toBeVisible();
  expect(requests).toEqual([]);
});

async function makeWorkbook(): Promise<Buffer> {
  const zip = new JSZip();
  const parts = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/office-workbook.json'), 'utf8')) as Record<string, string>;
  for (const [name, xml] of Object.entries(parts)) zip.file(name, xml);
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('XLSX save retains numbers, formulas and other sheets', async ({ app, harness }) => {
  app.setDefaultTimeout(10000);
  const dir = path.join(harness.rootDir, 'xlsx-fixtures');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'sample.xlsx');
  fs.writeFileSync(file, await makeWorkbook());
  const original = fs.readFileSync(file);
  const csv = path.join(dir, 'sample.csv');
  fs.writeFileSync(csv, 'a,b\nc,d');
  const project = await harness.createProject('xlsx-preview');
  await harness.api(`/projects/${project}/servers/local`, { method: 'PUT', body: JSON.stringify({ working_directory: dir }) });
  await app.addInitScript(() => { localStorage.setItem('azito-terminal-theme', JSON.stringify({ version: 1, global: { palette: { background: '#ffffff', foreground: '#111111' }, background: { scope: 'app' } }, customThemes: {}, projectOverrides: {} })); });
  await app.goto(`${harness.baseUrl}/workspace/${project}`);
  const before = await app.evaluate(() => { const label = document.createElement('label'); label.id = 'outside-workbook-label'; label.textContent = 'Outside'; document.body.append(label); return getComputedStyle(label).cursor; });
  await app.getByTitle('ファイル', { exact: true }).click();
  await app.getByText('sample.xlsx', { exact: true }).click();
  await app.getByRole('tab', { name: /sample\.xlsx/ }).click({ button: 'right' });
  await app.getByText('タブをピン留め', { exact: true }).click();
  await expect(app.getByText(/数式の再計算が必要な場合があります/).first()).toBeVisible();
  expect(await app.locator('#outside-workbook-label').evaluate((label) => getComputedStyle(label).cursor)).toBe(before);
  await expect(app.locator('html')).toHaveAttribute('data-bg-scope', 'app');
  expect(await app.locator('html').evaluate((element) => element.style.getPropertyValue('--surface-base'))).toBe('#ffffff');
  const contrast = await app.locator('.fortune-toolbar').evaluate((element) => {
    const style = getComputedStyle(element);
    const luminance = (color: string) => {
      const values = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map((value) => { const s = value / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
      return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
    };
    const a = luminance(style.color), b = luminance(style.backgroundColor);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
  expect(contrast).toBeGreaterThanOrEqual(4.5);
  await app.setViewportSize({ width: 600, height: 800 });
  await expect(app.getByText(/狭い画面では XLSX を編集できません/)).toBeVisible();
  await expect(app.getByRole('button', { name: '編集', exact: true })).toBeDisabled();
  await app.setViewportSize({ width: 1280, height: 800 });
  await expect(app.getByText(/狭い画面では XLSX を編集できません/)).toHaveCount(0);
  await app.getByRole('button', { name: '編集', exact: true }).click();
  await app.getByRole('alertdialog').getByRole('button', { name: '編集', exact: true }).click();
  await app.locator('.luckysheet-cell-sheettable').click({ position: { x: 220, y: 20 } });
  await app.keyboard.type('9');
  await app.keyboard.press('Enter');
  await app.getByText('sample.csv', { exact: true }).click();
  const cell = app.getByLabel('1, 1');
  await cell.fill('edited');
  await expect(app.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
  const csvSaved = app.waitForResponse((response) => response.request().method() === 'PUT' && response.url().endsWith('/files/binary'));
  await cell.press('Control+s');
  expect((await csvSaved).ok()).toBe(true);
  expect(fs.readFileSync(csv, 'utf8')).toBe('edited,b\nc,d');
  expect(fs.readFileSync(file).equals(original)).toBe(true);
  await app.getByRole('tab', { name: /sample\.csv/ }).click({ button: 'right' });
  await app.getByText('タブをピン留め', { exact: true }).click();
  await cell.fill('still pending');
  await expect(app.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
  await app.getByRole('tab', { name: /sample\.xlsx/ }).click();
  const saved = app.waitForResponse((response) => response.request().method() === 'PUT' && response.url().endsWith('/files/binary'));
  await app.getByRole('button', { name: '保存', exact: true }).focus();
  await app.keyboard.press('Control+s');
  expect((await saved).ok()).toBe(true);
  expect(fs.readFileSync(csv, 'utf8')).toBe('edited,b\nc,d');
  await expect(app.getByText('未保存', { exact: true })).toHaveCount(1);
  await app.setViewportSize({ width: 1200, height: 800 });
  await expect(app.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await expect(app.getByText('未保存', { exact: true })).toHaveCount(1);
  await expect(app.getByRole('button', { name: '編集', exact: true })).toBeDisabled();
  await app.locator('.luckysheet-cell-sheettable').click({ position: { x: 310, y: 60 } });
  await app.keyboard.type('10');
  await app.keyboard.press('Enter');
  const savedAgain = app.waitForResponse((response) => response.request().method() === 'PUT' && response.url().endsWith('/files/binary'));
  await app.getByRole('button', { name: '保存', exact: true }).click();
  expect((await savedAgain).ok()).toBe(true);
  const result = await JSZip.loadAsync(fs.readFileSync(file));
  const first = await result.file('xl/worksheets/sheet1.xml')!.async('string');
  expect(first).toMatch(/<c r="E3"[^>]*><v>10<\/v><\/c>/);
  expect(first).toMatch(/<c r="A1"[^>]*><v>3<\/v><\/c>/);
  expect(first).toContain('<f>A1*2</f>');
  expect(await result.file('xl/workbook.xml')!.async('string')).toContain('Sheet2');
  expect(await result.file('xl/sharedStrings.xml')!.async('string')).toContain('other');
});

test('signed media URLs require the capability and support ranges', async ({ harness }) => {
  const dir = path.join(harness.rootDir, 'media-fixtures');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'sample.mp4');
  fs.writeFileSync(file, '0123456789');
  const project = await harness.createProject('media-preview');
  await harness.api(`/projects/${project}/servers/local`, { method: 'PUT', body: JSON.stringify({ working_directory: dir }) });
  const { url } = await harness.api<{ url: string }>(`/servers/local/files/media-url?${new URLSearchParams({ path: file, projectId: String(project) })}`);
  expect(url.length).toBeGreaterThan(100);
  const partial = await fetch(harness.baseUrl + url, { headers: { Range: 'bytes=2-4' } });
  expect(partial.status).toBe(206);
  expect(partial.headers.get('content-range')).toBe('bytes 2-4/10');
  expect(await partial.text()).toBe('234');
  expect((await fetch(harness.baseUrl + url, { headers: { Range: 'bytes=10-' } })).status).toBe(416);
  expect((await fetch(harness.baseUrl + url, { headers: { Range: 'bytes=0-1,3-4' } })).status).toBe(200);
  expect((await fetch(harness.baseUrl + url + 'x')).status).toBe(401);
  expect((await fetch(`${harness.baseUrl}/api/servers/local/files`)).status).toBe(401);
});
