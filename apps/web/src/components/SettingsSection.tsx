import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { CardFrame } from './ui';

/**
 * Aufklappbarer Abschnitt der Einstellungen. Der Inhalt wird erst beim Öffnen geladen. `#<id>` in der Adresse öffnet
 * den Abschnitt direkt (Links von anderen Seiten); beim Öffnen landet die id in der Adresse, damit ein Neuladen sie behält.
 */
export function SettingsSection({ id, title, icon, summary, children }: { id: string; title: string; icon?: ReactNode; summary?: ReactNode; children: ReactNode }) {
  const { hash } = useLocation();
  const [open, setOpen] = useState(hash === `#${id}`);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (hash !== `#${id}`) return;
    setOpen(true);
    ref.current?.scrollIntoView({ block: 'start' });
  }, [hash, id]);

  const toggle = () => {
    setOpen(!open);
    if (!open) history.replaceState(null, '', `#${id}`);
  };

  return (
    <section id={id} ref={ref} className={`settings-section ${open ? 'open' : ''}`}>
      <button type="button" className="settings-section-head" aria-expanded={open} aria-controls={`${id}-body`} onClick={toggle}>
        <ChevronRight size={18} className="settings-section-chevron" aria-hidden />
        {icon}
        <span className="settings-section-title">{title}</span>
        {summary && <span className="settings-section-summary">{summary}</span>}
      </button>
      {open && (
        <div id={`${id}-body`} className="settings-section-body">
          <CardFrame.Provider value={{ sectionTitle: title }}>{children}</CardFrame.Provider>
        </div>
      )}
    </section>
  );
}

/** Überschrift einer Gruppe von Abschnitten */
export function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="settings-group">
      <h2 className="settings-group-title">{title}</h2>
      {children}
    </div>
  );
}
