import { ProjectAvatar } from '@azito/frontend';

export const SizesAndColors = () => (
  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
    <ProjectAvatar project={{ name: 'azito', color: '#4f8cff' }} size={40} />
    <ProjectAvatar project={{ name: 'Kaguya', color: '#3fb950' }} size={32} />
    <ProjectAvatar project={{ name: 'wireframes-cms', color: '#d29922' }} size={24} />
    <ProjectAvatar project={{ name: 'herdr', color: '#f85149' }} size={20} />
  </div>
);

export const AccentFallback = () => (
  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
    <ProjectAvatar project={{ name: 'azito' }} size={32} />
    <ProjectAvatar project={{ name: 'ops-dashboard', color: null }} size={32} />
  </div>
);

export const NoProject = () => (
  <ProjectAvatar project={null} size={32} />
);

export const InListContext = () => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
    <ProjectAvatar project={{ name: 'azito', color: '#4f8cff' }} size={28} />
    <div>
      <div style={{ fontSize: 13, fontWeight: 600 }}>azito</div>
      <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>12 tasks - 3 windows</div>
    </div>
  </div>
);
