import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowLeft, Search, UserRound } from 'lucide-react';
import { fullName, type LoginCandidate } from '@elvis/shared';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../lib/toast';
import { Loading } from '../ui';
import { PinPad } from './PinPad';

const norm = (s: string) => s.toLocaleLowerCase('de-DE').normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Anmeldung: Namen in der Suchliste wählen, dann die 4-stellige PIN eingeben. */
export function LoginDialog({ onDone }: { onDone: () => void }) {
  const { refresh } = useAuth();
  const toast = useToast();
  const { data: candidates, isLoading } = useQuery({ queryKey: ['users', 'candidates'], queryFn: api.loginCandidates, staleTime: 0 });
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [selected, setSelected] = useState<LoginCandidate | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const filtered = useMemo(() => {
    const terms = norm(query).split(/\s+/).filter(Boolean);
    return (candidates ?? []).filter((c) => terms.every((t) => norm(`${c.firstName} ${c.lastName}`).includes(t)));
  }, [candidates, query]);

  const login = useMutation({
    mutationFn: (p: string) => api.login(selected!.id, p),
    onSuccess: async (user) => {
      await refresh();
      toast('success', `Angemeldet als ${fullName(user)}`);
      onDone();
    },
    onError: (e) => {
      setError(e.message);
      setPin('');
    },
  });

  if (isLoading) return <Loading />;

  if (selected) {
    return (
      <div className="login-pin">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => (setSelected(null), setPin(''), setError(null))}>
          <ArrowLeft size={16} /> Anderer Name
        </button>
        <div className="login-who">
          <UserRound size={28} />
          <strong>{fullName(selected)}</strong>
        </div>
        <PinPad
          value={pin}
          onChange={(v) => (setPin(v), setError(null))}
          onComplete={(p) => login.mutate(p)}
          disabled={login.isPending}
        />
        <p className={`login-msg ${error ? 'tone-alarm' : 'muted'}`} role="alert">
          {error ?? (login.isPending ? 'Prüfe PIN …' : 'PIN eingeben')}
        </p>
      </div>
    );
  }

  const choose = (c: LoginCandidate | undefined) => c && (setSelected(c), setError(null));

  return (
    <div className="login-search">
      <label className="search-field">
        <Search size={18} />
        <input
          autoFocus
          value={query}
          onChange={(e) => (setQuery(e.target.value), setActive(0))}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') (e.preventDefault(), setActive((a) => Math.min(a + 1, filtered.length - 1)));
            if (e.key === 'ArrowUp') (e.preventDefault(), setActive((a) => Math.max(a - 1, 0)));
            if (e.key === 'Enter') choose(filtered[active]);
          }}
          placeholder="Name suchen …"
          aria-label="Name suchen"
          role="combobox"
          aria-expanded="true"
          aria-controls="login-candidates"
        />
      </label>
      <ul ref={listRef} id="login-candidates" className="candidate-list" role="listbox">
        {filtered.map((c, i) => (
          <li key={c.id} role="option" aria-selected={i === active}>
            <button type="button" className={`candidate ${i === active ? 'active' : ''}`} onClick={() => choose(c)} onMouseEnter={() => setActive(i)}>
              <UserRound size={18} />
              <span>
                {c.firstName} <strong>{c.lastName}</strong>
              </span>
            </button>
          </li>
        ))}
        {filtered.length === 0 && <li className="muted candidate-empty">Kein Benutzer gefunden</li>}
      </ul>
    </div>
  );
}
