import React from 'react';

interface PageContainerProps {
  maxWidth?: number;
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}

export function PageContainer({ maxWidth = 1400, className, style, children }: PageContainerProps) {
  return (
    <div
      className={className}
      // width: '100%' は必須: 親がflexコンテナの場合、交差軸のautoマージン（margin: 0 auto）は
      // stretch配置を無効化するため、明示しないと幅がコンテンツにフィットして縮む
      style={{ width: '100%', maxWidth, margin: '0 auto', padding: 'var(--space-6) var(--space-4)', height: '100%', overflowY: 'auto', ...style }}
    >
      {children}
    </div>
  );
}
