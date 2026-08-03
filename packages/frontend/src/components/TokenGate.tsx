import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { FormInput } from './ui/FormInput';
import { Button } from './ui/Button';
import { hasUiToken, setUiToken } from '../api/token';

interface TokenGateProps {
  children: React.ReactNode;
}

export function TokenGate({ children }: TokenGateProps) {
  const { t } = useTranslation('common');
  const [authenticated, setAuthenticated] = useState(hasUiToken());
  const [inputValue, setInputValue] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const handler = () => setAuthenticated(hasUiToken());
    window.addEventListener('azito:token-changed', handler);
    return () => window.removeEventListener('azito:token-changed', handler);
  }, []);

  const handleSubmit = useCallback(() => {
    const trimmed = inputValue.trim();
    if (!trimmed) {
      setError(t('tokenGate.tokenRequired'));
      return;
    }
    setUiToken(trimmed);
    setInputValue('');
    setError('');
  }, [inputValue, t]);

  if (authenticated) return <>{children}</>;

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      background: 'var(--bg)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 200,
      padding: 16,
    }}>
      <div style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        padding: 24,
        width: '100%',
        maxWidth: 400,
      }}>
        <h2 style={{ fontSize: 'var(--font-xl)', marginBottom: 8 }}>{t('tokenGate.title')}</h2>
        <p style={{ fontSize: 'var(--font-base)', color: 'var(--text-secondary)', marginBottom: 16 }}>
          {t('tokenGate.instruction')}
        </p>
        <form onSubmit={(e) => { e.preventDefault(); handleSubmit(); }}>
          <FormInput
            type="password"
            placeholder="AZITO_UI_TOKEN"
            value={inputValue}
            onChange={(e) => { setInputValue(e.target.value); setError(''); }}
            autoFocus
          />
          {error && (
            <p role="alert" style={{ color: 'var(--danger)', fontSize: 'var(--font-sm)', marginTop: 4 }}>
              {error}
            </p>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
            <Button variant="primary" type="submit">{t('actions.connect')}</Button>
          </div>
        </form>
      </div>
    </div>
  );
}
