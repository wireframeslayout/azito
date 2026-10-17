import { useEffect, useState } from 'react';
import { fetchSessionListing } from '../lib/fetchServerSessions';
import { selectableMuxKinds, type MuxAvailabilityState } from '../lib/muxKindChoice';

interface Result { serverName: string; state: MuxAvailabilityState }

/**
 * Which muxes `server` can use right now (`GET /sessions?detail=1` → `unavailable`). Checked while `enabled`, and only
 * for a server that offers more than one mux (there is nothing to pick on the others). A result belongs to the server
 * it was fetched for: after a server switch the state reads `loading` until the new answer arrives.
 */
export function useMuxKindAvailability(server: { name: string; type: string } | undefined, enabled: boolean): MuxAvailabilityState {
  const [result, setResult] = useState<Result | null>(null);
  const serverName = server && selectableMuxKinds(server).length > 1 ? server.name : undefined;

  useEffect(() => {
    if (!enabled || !serverName) return;
    let cancelled = false;
    fetchSessionListing(serverName)
      .then((listing) => { if (!cancelled) setResult({ serverName, state: { status: 'ready', unavailable: listing.unavailable } }); })
      .catch(() => { if (!cancelled) setResult({ serverName, state: { status: 'error' } }); });
    return () => { cancelled = true; };
  }, [enabled, serverName]);

  if (result && result.serverName === serverName) return result.state;
  return { status: 'loading' };
}
