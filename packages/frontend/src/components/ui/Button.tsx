import { useTranslation } from 'react-i18next';

type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost';
type ButtonSize = 'sm' | 'md';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  loadingLabel?: string;
  children: React.ReactNode;
}

export function Button({
  variant = 'default',
  size = 'md',
  loading = false,
  loadingLabel,
  children,
  className,
  disabled,
  ...rest
}: ButtonProps) {
  const { t } = useTranslation('common');
  const classes = [
    'btn',
    variant !== 'default' ? `btn-${variant}` : '',
    size === 'sm' ? 'btn-sm' : '',
    className ?? '',
  ].filter(Boolean).join(' ');

  return (
    <button
      className={classes}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? (loadingLabel ?? t('actions.processing')) : children}
    </button>
  );
}
