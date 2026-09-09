/**
 * herdr PoC verification script — run on a machine with herdr server running.
 * Usage: HERDR_SESSION=azito npx tsx scripts/poc/herdr-verify.ts
 */
import { HerdrSocketClient } from '../../packages/server/src/modules/mux/herdr/HerdrSocketClient';

const SESSION = process.env.HERDR_SESSION ?? 'azito';

interface TestResult {
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  detail: string;
}

const results: TestResult[] = [];

function log(msg: string) { console.log(msg); }

function record(name: string, status: 'PASS' | 'FAIL' | 'SKIP', detail: string) {
  results.push({ name, status, detail });
  const icon = status === 'PASS' ? '✅' : status === 'FAIL' ? '❌' : '⏭️';
  log(`  ${icon} ${status}: ${detail}`);
}

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ─── Test 1: Independent Client Focus ───

async function testIndependentFocus() {
  log('\n--- Test 1: Independent Client Focus ---');
  const c1 = new HerdrSocketClient(SESSION);
  const c2 = new HerdrSocketClient(SESSION);
  try {
    const snap1 = await c1.call('session.snapshot') as any;
    const workspaces = snap1.workspaces ?? [];
    if (workspaces.length === 0) {
      record('independent-focus', 'SKIP', 'No workspaces found in session');
      return;
    }
    const ws = workspaces[0];
    if ((ws.tabs?.length ?? 0) < 2) {
      record('independent-focus', 'SKIP', `Need >=2 tabs, found ${ws.tabs?.length ?? 0}. Create a second tab first`);
      return;
    }
    const tab0 = ws.tabs[0];
    const tab1 = ws.tabs[1];

    // Focus tab0 on client 1
    await c1.call('tab.focus', { tab_id: tab0.id });
    await sleep(200);

    // Focus tab1 on client 2
    await c2.call('tab.focus', { tab_id: tab1.id });
    await sleep(200);

    // Check client 1's view — is it still on tab0?
    const snap2 = await c1.call('session.snapshot') as any;
    const wsAfter = snap2.workspaces?.[0];
    const activeTab = wsAfter?.tabs?.find((t: any) => t.active);

    if (activeTab?.id === tab0.id) {
      record('independent-focus', 'PASS', 'Client 1 focus unchanged after client 2 switched tabs');
    } else if (activeTab?.id === tab1.id) {
      record('independent-focus', 'FAIL', 'Client 2 tab.focus changed client 1 active tab — shared view');
    } else {
      record('independent-focus', 'FAIL', `Unexpected active tab: ${activeTab?.id}`);
    }
  } catch (err) {
    record('independent-focus', 'FAIL', `Error: ${(err as Error).message}`);
  } finally {
    c1.close();
    c2.close();
  }
}

// ─── Test 2: Env Injection ───

async function testEnvInjection() {
  log('\n--- Test 2: Env Injection ---');
  const client = new HerdrSocketClient(SESSION);
  try {
    const marker = `AZITO_VERIFY_${Date.now()}`;
    const ws = await client.call('workspace.create', {
      name: `verify-env-${Date.now()}`,
      env: { AZITO_TEST_VAR: marker },
    }) as any;

    await sleep(500);

    const tab = ws.tab ?? ws.tabs?.[0];
    const pane = tab?.panes?.[0] ?? tab?.pane;
    const paneId = pane?.id ?? tab?.id;

    if (!paneId) {
      record('env-injection', 'SKIP', 'Could not determine pane id from workspace.create response');
      return;
    }

    // Send env command and read output
    await client.call('pane.send_text', { pane_id: paneId, text: `echo "HERDR_PANE=$HERDR_PANE_ID CUSTOM=$AZITO_TEST_VAR"\n` });
    await sleep(1000);

    const readResult = await client.call('pane.read', { pane_id: paneId, source: 'recent' }) as any;
    const content = readResult.content ?? readResult.text ?? '';

    const hasHerdr = content.includes('HERDR_PANE=') && !content.includes('HERDR_PANE= ');
    const hasCustom = content.includes(`CUSTOM=${marker}`);

    if (hasHerdr && hasCustom) {
      record('env-injection', 'PASS', 'Both HERDR_PANE_ID and custom env var visible in child process');
    } else {
      record('env-injection', 'FAIL', `HERDR_PANE_ID: ${hasHerdr}, custom var: ${hasCustom}. Output: ${content.slice(0, 200)}`);
    }

    // Cleanup
    await client.call('workspace.close', { workspace_id: ws.id }).catch(() => {});
  } catch (err) {
    record('env-injection', 'FAIL', `Error: ${(err as Error).message}`);
  } finally {
    client.close();
  }
}

// ─── Test 3: send_text Size Limit ───

async function testSendTextSize() {
  log('\n--- Test 3: send_text Size Limit ---');
  const client = new HerdrSocketClient(SESSION);
  try {
    const snap = await client.call('session.snapshot') as any;
    const ws = snap.workspaces?.[0];
    const paneId = ws?.tabs?.[0]?.panes?.[0]?.id;
    if (!paneId) {
      record('send-text-size', 'SKIP', 'No pane found');
      return;
    }

    const sizes = [
      { label: '1KB', bytes: 1024 },
      { label: '10KB', bytes: 10240 },
      { label: '100KB', bytes: 102400 },
    ];

    const outcomes: string[] = [];
    for (const { label, bytes } of sizes) {
      try {
        const text = 'x'.repeat(bytes);
        await client.call('pane.send_text', { pane_id: paneId, text });
        outcomes.push(`${label}=OK`);
      } catch (err) {
        outcomes.push(`${label}=FAIL(${(err as Error).message.slice(0, 60)})`);
      }
      await sleep(200);
      // Send Ctrl+C to recover from any half-sent state
      await client.call('pane.send_keys', { pane_id: paneId, keys: ['ctrl+c'] }).catch(() => {});
      await sleep(100);
    }

    const allOk = outcomes.every(o => o.includes('=OK'));
    record('send-text-size', allOk ? 'PASS' : 'FAIL', outcomes.join(', '));
  } catch (err) {
    record('send-text-size', 'FAIL', `Error: ${(err as Error).message}`);
  } finally {
    client.close();
  }
}

// ─── Test 4: Output Stream Alternative ───

async function testOutputStreamAlt() {
  log('\n--- Test 4: Output Stream Alternative (pane.read polling) ---');
  const client = new HerdrSocketClient(SESSION);
  try {
    const ws = await client.call('workspace.create', { name: `verify-output-${Date.now()}` }) as any;
    const tab = ws.tab ?? ws.tabs?.[0];
    const paneId = tab?.panes?.[0]?.id ?? tab?.pane?.id ?? tab?.id;
    if (!paneId) {
      record('output-stream-alt', 'SKIP', 'Could not determine pane id');
      return;
    }

    await sleep(500);

    // Have the pane echo a marker after a delay
    const marker = `AZITO_DONE_verify_${Date.now()}`;
    await client.call('pane.send_text', {
      pane_id: paneId,
      text: `sleep 1 && echo "${marker}"\n`,
    });

    // Poll pane.read at 250ms for up to 5s
    let found = false;
    const start = Date.now();
    while (Date.now() - start < 5000) {
      const read = await client.call('pane.read', { pane_id: paneId, source: 'recent' }) as any;
      const content = read.content ?? read.text ?? '';
      if (content.includes(marker)) {
        found = true;
        break;
      }
      await sleep(250);
    }

    const elapsed = Date.now() - start;
    if (found) {
      record('output-stream-alt', 'PASS', `Marker detected via pane.read polling in ${elapsed}ms`);
    } else {
      record('output-stream-alt', 'FAIL', `Marker not detected after 5s of 250ms polling`);
    }

    // Test events.subscribe pane.output_matched if available
    try {
      const evtClient = new HerdrSocketClient(SESSION);
      const marker2 = `AZITO_DONE_evt_${Date.now()}`;
      const subResult = await evtClient.call('events.subscribe', {
        events: ['pane.output_matched'],
        patterns: [{ pane_id: paneId, regex: 'AZITO_DONE_' }],
      });
      log(`  events.subscribe response: ${JSON.stringify(subResult)}`);
      record('output-matched-event', 'PASS', 'events.subscribe accepted pane.output_matched');
      evtClient.close();
    } catch (err) {
      record('output-matched-event', 'FAIL', `events.subscribe rejected: ${(err as Error).message.slice(0, 100)}`);
    }

    // Cleanup
    await client.call('workspace.close', { workspace_id: ws.id }).catch(() => {});
  } catch (err) {
    record('output-stream-alt', 'FAIL', `Error: ${(err as Error).message}`);
  } finally {
    client.close();
  }
}

// ─── Test 5: Tab Bar Visibility ───

async function testTabBarVisibility() {
  log('\n--- Test 5: Tab Bar Visibility ---');
  const client = new HerdrSocketClient(SESSION);
  try {
    const snap = await client.call('session.snapshot') as any;
    const ws = snap.workspaces?.[0];
    if (!ws) {
      record('tab-bar-visibility', 'SKIP', 'No workspace found');
      return;
    }

    const tabCount = ws.tabs?.length ?? 0;
    log(`  Current tab count: ${tabCount}`);

    if (tabCount === 1) {
      log('  With hide_tab_bar_when_single_tab=true, tab bar should be hidden');
      log('  Creating a second tab to test 2-tab visibility...');
      const newTab = await client.call('tab.create', { workspace_id: ws.id, name: 'verify-tab' }) as any;
      const snap2 = await client.call('session.snapshot') as any;
      const tabCount2 = snap2.workspaces?.[0]?.tabs?.length ?? 0;
      log(`  Tab count after create: ${tabCount2}`);
      log('  Visual confirmation needed: tab bar should now be visible');

      // Cleanup
      if (newTab?.id) {
        await client.call('tab.close', { tab_id: newTab.id }).catch(() => {});
      }
    }

    record('tab-bar-visibility', 'PASS', `Reported ${tabCount} tab(s). Visual confirmation needed for actual bar visibility`);
  } catch (err) {
    record('tab-bar-visibility', 'FAIL', `Error: ${(err as Error).message}`);
  } finally {
    client.close();
  }
}

// ─── Main ───

async function main() {
  log(`herdr PoC Verification — session: ${SESSION}`);
  log('='.repeat(50));

  // Pre-flight: check connectivity
  const probe = new HerdrSocketClient(SESSION);
  try {
    const ok = await probe.ping();
    if (!ok) {
      log('\nERROR: Cannot reach herdr socket. Is herdr server running?');
      log(`  Expected socket: ~/.config/herdr/sessions/${SESSION}/herdr.sock`);
      process.exit(1);
    }
    log(`Connected to herdr session "${SESSION}"`);
  } catch (err) {
    log(`\nERROR: ${(err as Error).message}`);
    log(`  Expected socket: ~/.config/herdr/sessions/${SESSION}/herdr.sock`);
    process.exit(1);
  } finally {
    probe.close();
  }

  await testIndependentFocus();
  await testEnvInjection();
  await testSendTextSize();
  await testOutputStreamAlt();
  await testTabBarVisibility();

  // Summary
  log('\n' + '='.repeat(50));
  log('Summary:');
  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  const skip = results.filter(r => r.status === 'SKIP').length;
  log(`  PASS: ${pass}  FAIL: ${fail}  SKIP: ${skip}`);
  for (const r of results) {
    const icon = r.status === 'PASS' ? '✅' : r.status === 'FAIL' ? '❌' : '⏭️';
    log(`  ${icon} ${r.name}: ${r.status}`);
  }

  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
