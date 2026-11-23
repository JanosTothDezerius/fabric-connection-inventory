import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConnectionRow } from '@rayfin-app/shared';

import { NameResolver, principalsNeedingNames, type PrincipalNamesState } from '@/services/principal-names';

/** Looks up, in Microsoft Entra ID, the owner names that Fabric did not return, as owner results arrive. */
export function usePrincipalNames(connections: readonly ConnectionRow[]) {
  const [state, setState] = useState<PrincipalNamesState>(() => ({ results: new Map(), loading: false }));
  const resolver = useRef<NameResolver | null>(null);

  useEffect(() => {
    const instance = new NameResolver(setState);
    resolver.current = instance;
    return () => {
      instance.dispose();
      resolver.current = null;
    };
  }, []);

  useEffect(() => {
    resolver.current?.add(principalsNeedingNames(connections));
  }, [connections]);

  const retry = useCallback(() => resolver.current?.retry(), []);

  return { ...state, retry };
}
