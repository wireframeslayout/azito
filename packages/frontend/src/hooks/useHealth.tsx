import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '../api/client';

interface HealthResponse {
  status: string;
  scopedAuthEnabled: boolean;
}

interface HealthContextValue {
  /**
   * Whether scoped authorization (AZITO_SCOPED_AUTH) is actually enforced —
   * `null` while the initial GET /api/health hasn't resolved yet. `false`
   * covers both "explicitly off" and "not yet known" for callers that only
   * care about not overclaiming enforcement (Issue #28 third-party review
   * Important finding: TaskOwnedPaneBadge previously showed "restricted
   * privileges" unconditionally, including in compat mode, where a UI token
   * is deliberately injected into every task pane and no restriction is
   * actually in effect).
   */
  scopedAuthEnabled: boolean | null;
}

const HealthContext = createContext<HealthContextValue>({ scopedAuthEnabled: null });

export function useHealth(): HealthContextValue {
  return useContext(HealthContext);
}

/**
 * Fetches GET /api/health once on mount and shares the result via context —
 * reusing the existing health endpoint (extended with `scopedAuthEnabled`)
 * rather than adding a new one, so every consumer (currently just
 * TaskOwnedPaneBadge) shares one request instead of each pane instance
 * fetching independently.
 */
export function HealthProvider({ children }: { children: ReactNode }) {
  const [scopedAuthEnabled, setScopedAuthEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<HealthResponse>('/health')
      .then((res) => {
        if (!cancelled) setScopedAuthEnabled(res.scopedAuthEnabled);
      })
      .catch(() => {
        // Fail closed for the badge's purposes: an unknown state must never
        // be read as "restricted" when it might not be (see scopedAuthEnabled
        // doc comment above) — leaving it `null` here does that.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return <HealthContext.Provider value={{ scopedAuthEnabled }}>{children}</HealthContext.Provider>;
}
