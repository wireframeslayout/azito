interface ProjectAvatarProps {
  project: { name: string; icon?: string | null; color?: string | null } | null;
  size: number;
}

export function ProjectAvatar({ project, size }: ProjectAvatarProps) {
  const borderRadius = size * 0.22;

  if (!project) {
    return (
      <span
        style={{
          width: size,
          height: size,
          borderRadius,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          background: 'var(--accent)',
          color: '#fff', // lint-allow: hex - white text on solid accent fill; no on-color token yet
          fontSize: size * 0.5,
        }}
      >
        &#9633;
      </span>
    );
  }

  const isImageIcon = Boolean(project.icon?.startsWith('data:'));
  const content = project.icon || project.name.charAt(0).toUpperCase();

  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        background: isImageIcon ? 'transparent' : (project.color || 'var(--accent)'),
        color: '#fff', // lint-allow: hex - white text on solid accent/project-color fill; no on-color token yet
        fontSize: project.icon && !isImageIcon ? size * 0.5 : size * 0.42,
        fontWeight: project.icon && !isImageIcon ? undefined : 700,
      }}
    >
      {isImageIcon ? (
        <img src={project.icon!} alt="" style={{ width: size, height: size, objectFit: 'cover' }} />
      ) : content}
    </span>
  );
}
