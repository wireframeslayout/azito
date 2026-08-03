import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from './ui';

export type BrowserDialogType = 'alert' | 'confirm' | 'prompt' | 'beforeunload' | 'auth';

export interface BrowserDialogInfo {
  type: BrowserDialogType;
  message: string;
  defaultValue: string;
  origin?: string;
}

interface BrowserDialogProps {
  dialog: BrowserDialogInfo | null;
  onResponse: (accept: boolean, text?: string) => void;
  onAuthResponse?: (username: string, password: string) => void;
}

const DIALOG_TITLE_KEYS: Record<string, string> = {
  alert: 'dialog.alert',
  confirm: 'dialog.confirm',
  prompt: 'dialog.prompt',
  beforeunload: 'dialog.beforeunload',
  auth: 'dialog.signIn',
};

export default function BrowserDialog({ dialog, onResponse, onAuthResponse }: BrowserDialogProps) {
  const { t } = useTranslation('browser');
  const [inputValue, setInputValue] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const usernameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (dialog) {
      setInputValue(dialog.defaultValue ?? '');
      if (dialog.type === 'auth') {
        setUsername('');
        setPassword('');
      }
    }
  }, [dialog]);

  useEffect(() => {
    if (dialog?.type === 'prompt') {
      requestAnimationFrame(() => inputRef.current?.focus());
    } else if (dialog?.type === 'auth') {
      requestAnimationFrame(() => usernameRef.current?.focus());
    }
  }, [dialog]);

  const handleAccept = useCallback(() => {
    if (!dialog) return;
    if (dialog.type === 'auth') {
      onAuthResponse?.(username, password);
    } else if (dialog.type === 'prompt') {
      onResponse(true, inputValue);
    } else {
      onResponse(true);
    }
  }, [dialog, inputValue, username, password, onResponse, onAuthResponse]);

  const handleDismiss = useCallback(() => {
    onResponse(false);
  }, [onResponse]);

  useEffect(() => {
    if (!dialog) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (dialog.type === 'alert') {
          handleAccept();
        } else {
          handleDismiss();
        }
      } else if (e.key === 'Enter' && dialog.type !== 'prompt' && dialog.type !== 'auth') {
        e.preventDefault();
        handleAccept();
      }
    };
    document.addEventListener('keydown', handleKey, true);
    return () => document.removeEventListener('keydown', handleKey, true);
  }, [dialog, handleAccept, handleDismiss]);

  if (!dialog) return null;

  const isAlert = dialog.type === 'alert';
  const isPrompt = dialog.type === 'prompt';
  const isAuth = dialog.type === 'auth';
  const title = DIALOG_TITLE_KEYS[dialog.type] ? t(DIALOG_TITLE_KEYS[dialog.type]) : t('dialog.default');

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: 'var(--overlay)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 50,
        padding: 16,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          if (isAlert) handleAccept();
          else handleDismiss();
        }
      }}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        style={{
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          padding: 20,
          width: '100%',
          maxWidth: 400,
        }}
      >
        <h3 style={{
          fontSize: 'var(--font-base)',
          fontWeight: 600,
          margin: '0 0 var(--space-3) 0',
          color: 'var(--text)',
        }}>
          {title}
        </h3>

        {isAuth && dialog.origin && (
          <p style={{
            fontSize: 'var(--font-xs)',
            color: 'var(--text-dimmer)',
            lineHeight: 1.4,
            margin: '0 0 var(--space-3) 0',
            wordBreak: 'break-all',
          }}>
            {dialog.origin}
          </p>
        )}

        {!isAuth && (
          <p style={{
            fontSize: 'var(--font-sm)',
            color: 'var(--text-dim)',
            lineHeight: 1.6,
            margin: 0,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}>
            {dialog.message}
          </p>
        )}

        {isPrompt && (
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleAccept();
              }
            }}
            style={{
              width: '100%',
              marginTop: 'var(--space-3)',
              padding: '6px 8px',
              background: 'var(--bg)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--text)',
              fontSize: 'var(--font-sm)',
              outline: 'none',
              boxSizing: 'border-box',
            }}
            aria-label={t('dialog.inputAriaLabel')}
          />
        )}

        {isAuth && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            <div>
              <label
                htmlFor="auth-username"
                style={{
                  display: 'block',
                  fontSize: 'var(--font-xs)',
                  color: 'var(--text-dim)',
                  marginBottom: 4,
                }}
              >
                {t('dialog.username')}
              </label>
              <input
                id="auth-username"
                ref={usernameRef}
                type="text"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAccept();
                  }
                }}
                style={{
                  width: '100%',
                  padding: '6px 8px',
                  background: 'var(--bg)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--text)',
                  fontSize: 'var(--font-sm)',
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
            </div>
            <div>
              <label
                htmlFor="auth-password"
                style={{
                  display: 'block',
                  fontSize: 'var(--font-xs)',
                  color: 'var(--text-dim)',
                  marginBottom: 4,
                }}
              >
                {t('dialog.password')}
              </label>
              <input
                id="auth-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAccept();
                  }
                }}
                style={{
                  width: '100%',
                  padding: '6px 8px',
                  background: 'var(--bg)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--text)',
                  fontSize: 'var(--font-sm)',
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
            </div>
          </div>
        )}

        <div style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 8,
          marginTop: 'var(--space-4)',
        }}>
          {!isAlert && (
            <Button onClick={handleDismiss}>
              {t('common:actions.cancel')}
            </Button>
          )}
          <Button variant="primary" onClick={handleAccept}>
            {isAuth ? t('dialog.signIn') : t('dialog.ok')}
          </Button>
        </div>
      </div>
    </div>
  );
}
