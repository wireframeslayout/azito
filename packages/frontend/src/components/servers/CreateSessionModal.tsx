import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MuxDriverKind } from '@azito/shared';
import Modal from '../Modal';
import FormField from '../FormField';
import MuxKindField from '../workspace/MuxKindField';
import { FormInput, Button } from '../ui';
import { useMuxKindAvailability } from '../../hooks/useMuxKindAvailability';
import { muxKindSelectModel } from '../../lib/muxKindChoice';

interface CreateSessionModalProps {
  server: { name: string; type: string; defaultMux: MuxDriverKind };
  onClose: () => void;
  /** Creates the session in `kind`. Resolves with an error text to show, or null when it succeeded (the parent then closes the modal). */
  onCreate: (name: string, kind: MuxDriverKind) => Promise<string | null>;
}

/** New session on a server. Mounted only while open, so its fields start fresh every time. */
export default function CreateSessionModal({ server, onClose, onCreate }: CreateSessionModalProps) {
  const { t } = useTranslation(['servers', 'common']);
  const [name, setName] = useState('');
  const [choice, setChoice] = useState<MuxDriverKind | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const availability = useMuxKindAvailability(server, true);
  const model = muxKindSelectModel(server, availability, choice);

  const submit = async (): Promise<void> => {
    if (submitting || !name.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      setError(await onCreate(name.trim(), model.value));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title={t('windows.createSession')}
      open
      onClose={onClose}
      maxWidth={400}
      actions={
        <Button variant="primary" onClick={() => void submit()} loading={submitting} disabled={!name.trim()} loadingLabel={t('windows.creating')}>
          {t('windows.createSession')}
        </Button>
      }
    >
      <MuxKindField model={model} onChange={setChoice} disabled={submitting} />
      <FormField label={t('windows.sessionName')} error={error ?? undefined}>
        <FormInput
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
          autoFocus
        />
      </FormField>
    </Modal>
  );
}
