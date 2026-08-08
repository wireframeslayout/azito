import { PageBody, PageHeader, ListRow, ListRowGroup, Chip, PixelIcon } from '@azito/frontend';

export const ListPageBody = () => (
  <div style={{ maxWidth: 640, border: '1px solid var(--border)', borderRadius: 8 }}>
    <PageHeader title="Servers" count={3} primaryAction={{ label: '+ Add Server', onClick: () => {} }} />
    <PageBody>
      <ListRowGroup>
        <ListRow
          icon={<PixelIcon name="servers" size={16} />}
          title="server01 (local)"
          description="WSL2 Ubuntu 24.04 · tmux 3.4"
          chips={<Chip tone="green">online</Chip>}
        />
        <ListRow
          icon={<PixelIcon name="servers" size={16} />}
          title="wakanda"
          description="agent · 100.84.12.7 via Tailscale"
          chips={<Chip tone="orange">offline</Chip>}
        />
        <ListRow
          icon={<PixelIcon name="servers" size={16} />}
          title="robin"
          description="ssh · robin@100.72.3.15:22"
          chips={<Chip tone="green">online</Chip>}
        />
      </ListRowGroup>
    </PageBody>
  </div>
);
