import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Building2, Contact as ContactIcon, FolderPlus, Pencil, Search, Trash2, User, UserPlus } from 'lucide-react';
import { contactName, folderPath, type Contact, type ContactCategory, type ContactData } from '@elvis/shared';
import { api } from '../lib/api';
import { useToast } from '../lib/toast';
import { Badge, Card, EmptyState, Field, Loading, Modal, PageHeader } from '../components/ui';
import { FolderSelect, FolderTree } from '../components/documents/FolderTree';
import { ContactForm, emptyContact } from '../components/contacts/ContactForm';

/** Kategorie und alle Unterkategorien */
function subtree(categories: ContactCategory[], id: number): Set<number> {
  const ids = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const c of categories) if (c.parentId !== null && ids.has(c.parentId) && !ids.has(c.id)) (ids.add(c.id), (grew = true));
  }
  return ids;
}

const searchText = (c: Contact) => [contactName(c), c.function, c.email, c.address, c.notes, ...c.phones.map((p) => p.number)].join(' ').toLowerCase();

/** Kontakte: globales Adressbuch des ELW mit Kategoriebaum */
export function ContactsPage() {
  const toast = useToast();
  const [category, setCategory] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Contact | 'new' | null>(null);
  const [categoryDialog, setCategoryDialog] = useState<'new' | 'edit' | null>(null);
  const [categoryForm, setCategoryForm] = useState<{ name: string; parentId: number | null }>({ name: '', parentId: null });
  const { data: contacts, isLoading } = useQuery({ queryKey: ['contacts'], queryFn: api.contacts });
  const { data: categories = [] } = useQuery({ queryKey: ['contacts', 'categories'], queryFn: api.contactCategories });
  const { data: mail } = useQuery({ queryKey: ['mail', 'available'], queryFn: api.mailAvailable });

  const current = categories.find((c) => c.id === category);
  const here = folderPath(categories, category) || 'Alle Kontakte';
  const counts = useMemo(() => {
    const m = new Map<number | null, number>();
    for (const c of contacts ?? []) for (const id of c.categoryIds) m.set(id, (m.get(id) ?? 0) + 1);
    return m;
  }, [contacts]);
  const shown = useMemo(() => {
    const inCategory = category === null ? null : subtree(categories, category);
    const q = query.trim().toLowerCase();
    return (contacts ?? []).filter((c) => (!inCategory || c.categoryIds.some((id) => inCategory.has(id))) && (!q || searchText(c).includes(q)));
  }, [contacts, categories, category, query]);

  const err = (e: Error) => toast('error', e.message);
  const save = useMutation({
    mutationFn: (data: ContactData) => (editing === 'new' ? api.createContact(data) : api.updateContact((editing as Contact).id, data)),
    onSuccess: (c) => (setEditing(null), toast('success', `${contactName(c)} gespeichert`)),
    onError: err,
  });
  const remove = useMutation({ mutationFn: (id: number) => api.removeContact(id), onError: err });
  const saveCategory = useMutation({
    mutationFn: () => {
      const input = { name: categoryForm.name.trim(), parentId: categoryForm.parentId };
      return categoryDialog === 'edit' && current ? api.updateContactCategory(current.id, input) : api.createContactCategory(input);
    },
    onSuccess: (c) => (setCategoryDialog(null), setCategory(c.id)),
    onError: err,
  });
  const removeCategory = useMutation({ mutationFn: (id: number) => api.removeContactCategory(id), onSuccess: () => setCategory(current?.parentId ?? null), onError: err });

  const categoryNames = (c: Contact) => c.categoryIds.map((id) => folderPath(categories, id)).filter(Boolean).sort((a, b) => a.localeCompare(b, 'de'));

  return (
    <>
      <PageHeader
        title="Kontakte"
        subtitle="Personen und Einrichtungen – Personal lässt sich auf der Seite der Einheit übernehmen"
        actions={
          <button className="btn btn-primary" onClick={() => setEditing('new')}>
            <UserPlus size={16} /> Neuer Kontakt
          </button>
        }
      />
      <div className="grid">
        <Card
          title="Kategorien"
          actions={
            <>
              <button
                className="btn btn-ghost btn-icon"
                onClick={() => (setCategoryForm({ name: '', parentId: category }), setCategoryDialog('new'))}
                aria-label="Neue Kategorie"
                title={`Neue Kategorie in „${here}“`}
              >
                <FolderPlus size={18} />
              </button>
              {current && (
                <>
                  <button
                    className="btn btn-ghost btn-icon"
                    onClick={() => (setCategoryForm({ name: current.name, parentId: current.parentId }), setCategoryDialog('edit'))}
                    aria-label="Kategorie umbenennen oder verschieben"
                    title="Umbenennen / verschieben"
                  >
                    <Pencil size={18} />
                  </button>
                  <button
                    className="btn btn-ghost btn-icon"
                    onClick={() => window.confirm(`Kategorie „${here}“ entfernen? Die Kontakte bleiben erhalten.`) && removeCategory.mutate(current.id)}
                    aria-label="Kategorie entfernen"
                  >
                    <Trash2 size={18} />
                  </button>
                </>
              )}
            </>
          }
        >
          <FolderTree folders={categories} rootLabel="Alle Kontakte" selected={category} onSelect={setCategory} counts={counts} />
        </Card>

        <Card title={`${here} (${shown.length})`} className="span-2">
          <label className="search-field">
            <Search size={18} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name, Telefon, E-Mail …" aria-label="Kontakte suchen" />
          </label>
          {isLoading ? (
            <Loading />
          ) : !shown.length ? (
            <EmptyState icon={<ContactIcon size={32} />} title={query ? 'Keine Treffer' : 'Keine Kontakte in dieser Kategorie'} />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Telefon</th>
                    <th>E-Mail / Anschrift</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {shown.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <div className="cell-title">
                          {c.kind === 'organization' ? <Building2 size={15} aria-label="Einrichtung" /> : <User size={15} aria-label="Person" />} {contactName(c)}
                        </div>
                        {c.function && <div className="cell-sub">{c.function}</div>}
                        {categoryNames(c).length > 0 && (
                          <span className="chip-row">
                            {categoryNames(c).map((n) => (
                              <Badge key={n}>{n}</Badge>
                            ))}
                          </span>
                        )}
                      </td>
                      <td>
                        {c.phones.length
                          ? c.phones.map((p, i) => (
                              <div key={i}>
                                <a href={`tel:${p.number.replace(/[^\d+]/g, '')}`} className="nowrap">{p.number}</a>
                                {p.label && <span className="muted"> · {p.label}</span>}
                              </div>
                            ))
                          : '–'}
                      </td>
                      <td>
                        {c.email ? mail?.available ? <Link to={`/mail?an=${encodeURIComponent(c.email)}`}>{c.email}</Link> : c.email : '–'}
                        {c.address && <div className="cell-sub">{c.address}</div>}
                        {c.notes && <div className="cell-sub">{c.notes}</div>}
                      </td>
                      <td className="cell-actions">
                        <button className="btn btn-ghost btn-icon" onClick={() => setEditing(c)} aria-label={`${contactName(c)} bearbeiten`} title="Bearbeiten">
                          <Pencil size={16} />
                        </button>
                        <button
                          className="btn btn-ghost btn-icon"
                          onClick={() => window.confirm(`Kontakt „${contactName(c)}“ löschen?`) && remove.mutate(c.id)}
                          aria-label={`${contactName(c)} löschen`}
                          title="Löschen"
                        >
                          <Trash2 size={16} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <Modal open={!!editing} title={editing === 'new' ? 'Neuer Kontakt' : 'Kontakt bearbeiten'} onClose={() => setEditing(null)} wide>
        {editing && (
          <ContactForm
            initial={editing === 'new' ? emptyContact(category === null ? [] : [category]) : { ...editing, phones: editing.phones.length ? editing.phones : [{ label: '', number: '' }] }}
            categories={categories}
            pending={save.isPending}
            onSubmit={(data) => save.mutate(data)}
            onCancel={() => setEditing(null)}
          />
        )}
      </Modal>

      <Modal open={!!categoryDialog} title={categoryDialog === 'edit' ? 'Kategorie bearbeiten' : 'Neue Kategorie'} onClose={() => setCategoryDialog(null)}>
        <form
          className="form-grid"
          onSubmit={(e) => {
            e.preventDefault();
            if (categoryForm.name.trim()) saveCategory.mutate();
          }}
        >
          <Field label="Name">
            <input value={categoryForm.name} onChange={(e) => setCategoryForm({ ...categoryForm, name: e.target.value })} maxLength={80} required autoFocus />
          </Field>
          <Field label="Liegt in">
            <FolderSelect
              folders={categoryDialog === 'edit' && current ? categories.filter((c) => !subtree(categories, current.id).has(c.id)) : categories}
              value={categoryForm.parentId}
              onChange={(parentId) => setCategoryForm({ ...categoryForm, parentId })}
              rootLabel="(oberste Ebene)"
            />
          </Field>
          <div className="btn-row">
            <button type="submit" className="btn btn-primary" disabled={saveCategory.isPending || !categoryForm.name.trim()}>
              Speichern
            </button>
            <button type="button" className="btn" onClick={() => setCategoryDialog(null)}>
              Abbrechen
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
}
