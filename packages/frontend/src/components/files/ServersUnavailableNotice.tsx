import type { ReactElement } from 'react';
import { Button } from '../ui/Button';
import { Notice } from '../ui/Notice';

interface ServersUnavailableNoticeProps {
  /** Why the server list could not be fetched, already in the user's language. */
  message: string;
  retryLabel: string;
  onRetry: () => void;
  retrying: boolean;
}

/** Shown in place of a restored tab while the first `/servers` fetch keeps failing: the reason, and a way to try again now. */
export function ServersUnavailableNotice({ message, retryLabel, onRetry, retrying }: ServersUnavailableNoticeProps): ReactElement {
  return (
    <div style={{ padding: 16 }}>
      <Notice
        tone="danger"
        action={<Button variant="default" size="sm" onClick={onRetry} disabled={retrying}>{retryLabel}</Button>}
      >
        {message}
      </Notice>
    </div>
  );
}
