import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Role, User } from '@elvis/shared';
import { api } from './api';

interface AuthState {
  user: User | null;
  /** Rolle der Sitzung im Einsatz */
  role: Role | null;
  /** false direkt nach der Anmeldung – dann wird nach der Rolle gefragt */
  roleChosen: boolean;
  hasUsers: boolean;
  loading: boolean;
  /** Nach Anmelden/Abmelden: Status und alle nutzerabhängigen Daten neu laden. */
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({ user: null, role: null, roleChosen: true, hasUsers: true, loading: true, refresh: async () => {} });

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['users', 'status'], queryFn: api.authStatus, staleTime: Infinity });

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['users', 'status'] });
    // Einsatz- und Verwaltungsdaten hängen vom Benutzer ab.
    await qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'users' });
  };

  useEffect(() => {
    const onUnauthorized = () => void qc.invalidateQueries({ queryKey: ['users', 'status'] });
    window.addEventListener('elvis:unauthorized', onUnauthorized);
    return () => window.removeEventListener('elvis:unauthorized', onUnauthorized);
  }, [qc]);

  return (
    <AuthContext.Provider value={{ user: data?.user ?? null, role: data?.role ?? null, roleChosen: data?.roleChosen ?? true, hasUsers: data?.hasUsers ?? true, loading: isLoading, refresh }}>{children}</AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
