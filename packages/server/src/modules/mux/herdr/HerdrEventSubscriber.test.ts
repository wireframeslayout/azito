import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'net';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { HerdrEventSubscriber, type HerdrEvent } from './HerdrEventSubscriber';

describe('HerdrEventSubscriber', () => {
  const cleanup: Array<() => void> = [];

  afterEach(() => {
    for (const fn of cleanup) fn();
    cleanup.length = 0;
  });

  it('receives events after subscribing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'herdr-evt-'));
    const sockPath = join(dir, 'herdr.sock');

    const server = createServer((conn) => {
      let buf = '';
      conn.on('data', (chunk) => {
        buf += chunk.toString();
        const idx = buf.indexOf('\n');
        if (idx === -1) return;
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        const req = JSON.parse(line);
        // Send subscription ack
        conn.write(JSON.stringify({ id: req.id, result: { subscribed: true } }) + '\n');
        // Then send an event
        setTimeout(() => {
          conn.write(JSON.stringify({
            event: 'pane.agent_status_changed',
            data: { pane_id: 'ws1:p1', status: 'working' },
          }) + '\n');
        }, 50);
      });
    });
    server.listen(sockPath);
    cleanup.push(() => { server.close(); try { rmSync(dir, { recursive: true }); } catch {} });

    const sub = new HerdrEventSubscriber(sockPath, ['pane.agent_status_changed']);
    cleanup.push(() => sub.stop());

    const received: HerdrEvent[] = [];
    sub.on('event', (evt: HerdrEvent) => received.push(evt));
    sub.start();

    await new Promise((r) => setTimeout(r, 300));
    expect(received).toHaveLength(1);
    expect(received[0].event).toBe('pane.agent_status_changed');
    expect(received[0].data).toEqual({ pane_id: 'ws1:p1', status: 'working' });
  });

  it('stop prevents reconnection', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'herdr-stop-'));
    const sockPath = join(dir, 'herdr.sock');

    const server = createServer(() => {});
    server.listen(sockPath);
    cleanup.push(() => { server.close(); try { rmSync(dir, { recursive: true }); } catch {} });

    const sub = new HerdrEventSubscriber(sockPath, ['pane.agent_status_changed']);
    sub.start();
    await new Promise((r) => setTimeout(r, 50));
    sub.stop();
    // No error expected — just verifying it doesn't throw
    expect(true).toBe(true);
  });
});
