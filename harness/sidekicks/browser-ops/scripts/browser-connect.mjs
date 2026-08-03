#!/usr/bin/env node

// CDP browser connection helpers for the browser-ops Sidekick.
// All configuration is read from environment variables (never template-expanded).

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    const fallbackPath =
      process.env.AZITO_PLAYWRIGHT_PATH ||
      new URL('../../../../node_modules/playwright', import.meta.url).pathname;
    return await import(fallbackPath);
  }
}

function resolveBaseUrl() {
  if (process.env.AZITO_AGENT_PORT) {
    return `http://127.0.0.1:${process.env.AZITO_AGENT_PORT}`;
  }
  if (process.env.AZITO_URL) {
    return process.env.AZITO_URL;
  }
  throw new Error('Neither AZITO_AGENT_PORT nor AZITO_URL is set');
}

function buildHeaders() {
  const headers = { 'content-type': 'application/json' };
  if (process.env.AZITO_AGENT_TOKEN) {
    headers['authorization'] = `Bearer ${process.env.AZITO_AGENT_TOKEN}`;
  }
  return headers;
}

export async function openTab(url, options = {}) {
  const baseUrl = resolveBaseUrl();
  const body = { url };
  if (!process.env.AZITO_AGENT_PORT) {
    if (!options.server) throw new Error('server is required when not on an agent server');
    body.server = options.server;
  }
  if (options.holdSeconds != null) body.holdSeconds = options.holdSeconds;
  if (options.taskId != null) body.taskId = options.taskId;
  if (options.label != null) body.label = options.label;

  const res = await fetch(`${baseUrl}/api/browser/open`, {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`browser/open failed (${res.status}): ${err}`);
  }
  return res.json();
}

export async function connect(cdpEndpoint) {
  const pw = await loadPlaywright();
  return pw.chromium.connectOverCDP(cdpEndpoint);
}

export async function getPage(browser, targetId) {
  const pages = browser.contexts()[0]?.pages() ?? [];
  if (!targetId || pages.length <= 1) return pages[0] ?? null;
  for (const p of pages) {
    try {
      const cdp = await p.context().newCDPSession(p);
      const info = await cdp.send('Target.getTargetInfo');
      await cdp.detach();
      if (info?.targetInfo?.targetId === targetId) return p;
    } catch {}
  }
  return pages[0] ?? null;
}

export async function fillFromEnv(page, selector, envKey) {
  const value = process.env[envKey];
  if (value == null) throw new Error(`Environment variable ${envKey} is not set`);
  await page.fill(selector, value);
}

export async function saveToStorage(filePath, projectId) {
  const baseUrl = process.env.AZITO_URL;
  if (!baseUrl) throw new Error('AZITO_URL is not set');

  const fs = await import('node:fs');
  const path = await import('node:path');

  const fileBuffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);

  const formData = new FormData();
  formData.append('file', new Blob([fileBuffer]), fileName);

  const res = await fetch(`${baseUrl}/api/projects/${projectId}/storage/upload`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`storage/upload failed (${res.status}): ${err}`);
  }
  return res.json();
}

export async function closeGroup(groupId, options = {}) {
  const baseUrl = resolveBaseUrl();
  const body = { group: groupId };
  if (!process.env.AZITO_AGENT_PORT) {
    if (!options.server) throw new Error('server is required when not on an agent server');
    body.server = options.server;
  }

  const res = await fetch(`${baseUrl}/api/browser/close-group`, {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`browser/close-group failed (${res.status}): ${err}`);
  }
  return res.json();
}
