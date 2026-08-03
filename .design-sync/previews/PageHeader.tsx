import { PageHeader, FormInput, PixelIcon } from '@azito/frontend';

export const ListPage = () => (
  <div style={{ maxWidth: 640, border: '1px solid var(--border)', borderRadius: 8 }}>
    <PageHeader
      title="Projects"
      count={6}
      primaryAction={{ label: '+ New Project', onClick: () => {} }}
      secondaryActions={[
        { label: 'Import', icon: <PixelIcon name="git" size={13} mono />, onClick: () => {} },
      ]}
    />
  </div>
);

export const WithSearch = () => (
  <div style={{ maxWidth: 640, border: '1px solid var(--border)', borderRadius: 8 }}>
    <PageHeader
      title="Tasks"
      count={42}
      primaryAction={{ label: '+ New Task', onClick: () => {} }}
    >
      <FormInput value="worktree" onChange={() => {}} placeholder="Search tasks…" style={{ width: 200 }} />
    </PageHeader>
  </div>
);

export const TitleCountOnly = () => (
  <div style={{ maxWidth: 640, border: '1px solid var(--border)', borderRadius: 8 }}>
    <PageHeader title="Units" count={3} />
  </div>
);
