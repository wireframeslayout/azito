import { execFile } from 'child_process';

export async function resolvePublicUrl(port: number, bind: string): Promise<string> {
  if (process.env.AZITO_PUBLIC_URL) return process.env.AZITO_PUBLIC_URL;
  try {
    const ip = await new Promise<string>((resolve, reject) => {
      execFile('tailscale', ['ip', '-4'], { timeout: 3000 }, (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout.trim().split('\n')[0]);
      });
    });
    if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
      if (bind === '127.0.0.1') {
        console.warn(
          `[resolvePublicUrl] publicUrl http://${ip}:${port} is unreachable while AZITO_BIND=127.0.0.1 — ` +
          'supervisors cannot register. Set AZITO_PUBLIC_URL (e.g. your tailscale serve HTTPS URL).',
        );
      }
      return `http://${ip}:${port}`;
    }
  } catch { /* tailscale not available */ }
  console.warn('[resolvePublicUrl] AZITO_PUBLIC_URL not set and Tailscale unavailable; falling back to localhost — remote servers will not reach the hub');
  return `http://localhost:${port}`;
}
