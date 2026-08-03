/**
 * azito API クライアント
 * AZITO_URL 環境変数からベースURLを読む。
 * AZITO_UI_TOKEN 環境変数が設定されている場合は Authorization ヘッダーに付加する。
 */

function getBaseUrl() {
  const url = process.env.AZITO_URL;
  if (!url) {
    throw new Error(
      "環境変数 AZITO_URL が未設定です。例: AZITO_URL=http://localhost:3001"
    );
  }
  return url.replace(/\/$/, "");
}

function buildHeaders() {
  const headers = { "Content-Type": "application/json" };
  const token = process.env.AZITO_UI_TOKEN;
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

async function handleResponse(res) {
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      const json = JSON.parse(text);
      detail = json.error ?? text;
    } catch {
      // テキストのままにする
    }
    throw new Error(`azito API エラー (HTTP ${res.status}): ${detail}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function azitoGet(path) {
  const base = getBaseUrl();
  const res = await fetch(`${base}${path}`, {
    method: "GET",
    headers: buildHeaders(),
  });
  return handleResponse(res);
}

export async function azitoPost(path, body) {
  const base = getBaseUrl();
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });
  return handleResponse(res);
}
