const fs = require("node:fs");
const args = process.argv.slice(2);
const command = args.shift();
function fail(message) { console.error(`azitoctl: ${String(message).replace(/[\r\n]+/g, " ")}`); process.exit(1); }
function parseId(value) {
  if (!/^(?:[wW]-?)?[0-9]+$/.test(value)) fail("ウィンドウ ID（W-123）を指定してください");
  const id = Number(value.replace(/^[wW]-?/, ""));
  if (!Number.isSafeInteger(id) || id <= 0) fail("ウィンドウ ID（W-123）を指定してください");
  return id;
}
async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(new URL(path, process.env.AZITO_URL), {
      ...options, headers: { Authorization: `Bearer ${process.env.AZITO_TASK_TOKEN || process.env.AZITO_UI_TOKEN}`, ...(process.env.AZITO_WINDOW_ID ? { "X-Azito-Window-Id": process.env.AZITO_WINDOW_ID } : {}), ...options.headers },
      signal: AbortSignal.timeout(120000),
    });
  } catch (error) { if (options.method === "POST" && (error.name === "TimeoutError" || error.name === "AbortError")) fail("timed out; message may have been delivered (do not retry)"); fail(`request failed: ${error.message}`); }
  if (!response.ok) {
    let reason = response.statusText;
    try {
      const body = await response.json();
      if (typeof body.error === "string" && body.error.trim()) reason = body.error;
    } catch { /* Non-JSON error responses retain the HTTP reason. */ }
    reason = reason.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 500);
    fail(`HTTP ${response.status} ${reason}`);
  }
  try { return await response.json(); } catch { fail("invalid API response"); }
}
async function whoami() {
  const query = new URLSearchParams();
  if (process.env.AZITO_WINDOW_ID) query.set("windowId", String(parseId(process.env.AZITO_WINDOW_ID)));
  else {
    const pane = process.env.TMUX_PANE || process.env.MISAO_PANE_ID;
    if (!pane || (!process.env.AZITO_TASK_TOKEN && !process.env.AZITO_SERVER_NAME)) fail("window ID or server and pane are required");
    if (process.env.AZITO_SERVER_NAME) query.set("server", process.env.AZITO_SERVER_NAME); query.set("paneHandle", pane);
  }
  return request(`/api/windows/whoami?${query}`);
}
async function main() {
  if (!process.env.AZITO_URL) fail("AZITO_URL is required");
  if (!process.env.AZITO_TASK_TOKEN && !process.env.AZITO_UI_TOKEN) fail("AZITO_TASK_TOKEN or AZITO_UI_TOKEN is required");
  if (command === "whoami") {
    if (args.length > 1 || (args.length === 1 && args[0] !== "--json")) fail("usage: azitoctl whoami [--json]");
    const identity = await whoami();
    console.log(args.length ? JSON.stringify(identity) : `${identity.idLabel} task=${identity.taskId == null ? "none" : `#${identity.taskId}`} server=${identity.serverName}`);
    return;
  }
  let windowId, stdin = false, positional = [];
  while (args.length) {
    const arg = args.shift();
    if (arg === "--window") { if (windowId !== undefined || !args.length) fail("--window requires one ID"); windowId = parseId(args.shift()); }
    else if (arg === "--stdin") { if (stdin) fail("duplicate --stdin"); stdin = true; }
    else if (arg === "--") { positional.push(...args); break; }
    else if (arg.startsWith("-")) fail(`unknown option: ${arg}`);
    else positional.push(arg);
  }
  if (windowId === undefined || (stdin ? positional.length !== 0 : positional.length !== 1)) fail("usage: azitoctl send --window <ID> [--stdin | <text>]");
  const text = stdin ? fs.readFileSync(0, "utf8") : positional[0];
  if (!text) fail("message cannot be empty");
  // Only a task token needs a sender window; an operator token is shown as the operator and may send from outside a window.
  const from = process.env.AZITO_TASK_TOKEN ? { from: { windowId: (await whoami()).windowId } } : {};
  await request(`/api/windows/${windowId}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, ...from }) });
  console.log(`Sent to W-${windowId}`);
}
main().catch(error => fail(error.message));
