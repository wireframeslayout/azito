export function buildBaseUrlCandidates(
  publicUrl: string | undefined,
  dnsName: string | null,
  tsIp: string | null,
  lanIps: string[],
  port: string,
): { label: string; url: string }[] {
  const candidates: { label: string; url: string }[] = [];
  if (publicUrl) candidates.push({ label: 'Public URL', url: publicUrl.replace(/\/$/, '') });
  if (dnsName) candidates.push({ label: 'Tailscale (DNS)', url: `http://${dnsName}:${port}` });
  if (tsIp) candidates.push({ label: 'Tailscale (IP)', url: `http://${tsIp}:${port}` });
  for (const ip of lanIps) candidates.push({ label: `LAN (${ip})`, url: `http://${ip}:${port}` });

  const seen = new Set<string>();
  return candidates.filter((c) => {
    const key = c.url.replace(/\/$/, '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
