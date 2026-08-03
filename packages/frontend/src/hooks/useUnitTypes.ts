import { useApi } from './useApi';
import type { UnitType } from '../pages/workspace/types';

export function useUnitTypes(): {
  unitTypes: UnitType[];
  loading: boolean;
  error: string | null;
} {
  const { data, loading, error } = useApi<UnitType[]>('/unit-types');
  return { unitTypes: data ?? [], loading, error };
}

export function findUnitType(unitTypes: UnitType[], name: string | undefined): UnitType | undefined {
  if (!name) return undefined;
  return unitTypes.find((ut) => ut.name === name);
}
