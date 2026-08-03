import { Children, cloneElement, isValidElement, type CSSProperties, type ReactElement, type ReactNode } from 'react';
import { useIsMobile } from '../../hooks/useIsMobile';

interface ListRowGroupProps {
  children: ReactNode;
}

export function ListRowGroup({ children }: ListRowGroupProps) {
  const items = Children.toArray(children).filter(isValidElement) as ReactElement<ListRowProps>[];

  return (
    <ul
      style={{
        listStyle: 'none',
        margin: 0,
        padding: 0,
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
        background: 'var(--bg-card)',
      }}
    >
      {items.map((child, i) => {
        const isLast = i === items.length - 1;
        return cloneElement(child, {
          key: child.key ?? i,
          style: {
            ...child.props.style,
            borderBottom: isLast ? undefined : '1px solid var(--border)',
          },
        });
      })}
    </ul>
  );
}

interface ListRowProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  chips?: ReactNode;
  rightActions?: ReactNode;
  selected?: boolean;
  accentColor?: string;
  size?: 'md' | 'sm';
  onClick?: () => void;
  ariaLabel?: string;
  style?: CSSProperties;
}

const rowInnerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '12px 16px',
  position: 'relative',
  transition: 'background 0.12s',
  width: '100%',
};

const rowInnerSmStyle: CSSProperties = {
  ...rowInnerStyle,
  padding: '8px 12px',
  gap: 8,
};

export function ListRow({ icon, title, description, chips, rightActions, selected, accentColor, size = 'md', onClick, ariaLabel, style }: ListRowProps) {
  const isSm = size === 'sm';
  const isMobile = useIsMobile();
  const iconSize = isSm ? 24 : 30;
  const iconRadius = isSm ? 5 : 7;
  const baseStyle = isSm ? rowInnerSmStyle : rowInnerStyle;
  const className = ['list-row', selected ? 'row-selected' : ''].filter(Boolean).join(' ');
  const stackChips = isMobile && !!chips;

  const content = (
    <>
      {accentColor && (
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: '0 auto 0 0',
            width: 3,
            background: accentColor,
          }}
        />
      )}
      {icon !== undefined && (
        <div
          style={{
            width: iconSize,
            height: iconSize,
            flexShrink: 0,
            borderRadius: iconRadius,
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: isSm ? 'var(--font-sm)' : 'var(--font-base)',
            overflow: 'hidden',
          }}
        >
          {icon}
        </div>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: isSm ? 'var(--font-sm)' : 'var(--font-md)',
            fontWeight: 600,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0,
          }}
        >
          {title}
        </div>
        {description && (
          <div
            style={{
              fontSize: isSm ? 'var(--font-xs)' : 'var(--font-xs)',
              color: 'var(--text-dim)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              marginTop: 2,
              minWidth: 0,
            }}
          >
            {description}
          </div>
        )}
        {stackChips && (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: 6,
              rowGap: 4,
              marginTop: 5,
              fontSize: 'var(--font-xs)',
            }}
          >
            {chips}
          </div>
        )}
      </div>
      {chips && !stackChips && (
        <div
          style={{
            flex: '0 1 auto',
            minWidth: 0,
            maxWidth: '50%',
            fontSize: 'var(--font-xs)',
            display: 'flex',
            flexWrap: 'wrap',
            justifyContent: 'flex-end',
            alignItems: 'center',
            gap: 6,
            rowGap: 4,
          }}
        >
          {chips}
        </div>
      )}
      {rightActions && (
        <div
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}
        >
          {rightActions}
        </div>
      )}
      {onClick && (
        <span
          className="list-row-arrow"
          aria-hidden="true"
          style={{ color: 'var(--text-dim)', fontSize: 'var(--font-sm)', opacity: 0, transition: 'opacity 0.12s', flexShrink: 0 }}
        >
          &rarr;
        </span>
      )}
    </>
  );

  return (
    <li style={style}>
      {onClick ? (
        <button
          type="button"
          className={className}
          aria-label={ariaLabel}
          onClick={onClick}
          style={{
            ...baseStyle,
            border: 'none',
            font: 'inherit',
            color: 'inherit',
            textAlign: 'left',
            cursor: 'pointer',
          }}
        >
          {content}
        </button>
      ) : (
        <div className={className} style={baseStyle}>
          {content}
        </div>
      )}
    </li>
  );
}
