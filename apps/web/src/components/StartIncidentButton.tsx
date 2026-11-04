import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { Siren } from 'lucide-react';
import { api } from '../lib/api';
import { useToast } from '../lib/toast';
import { IncidentForm } from '../pages/incident/IncidentForm';
import { Modal } from './ui';

/** Button „Lage anlegen“ mit modalem Dialog; nach dem Eröffnen geht es zur Lageübersicht */
export function StartIncidentButton({ className = 'btn btn-primary', label = 'Lage anlegen' }: { className?: string; label?: string }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const start = useMutation({
    mutationFn: api.startIncident,
    onSuccess: (i) => {
      setOpen(false);
      toast('success', `Lage „${i.title}“ eröffnet`);
      navigate('/lage');
    },
    onError: (e) => toast('error', e.message),
  });
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        <Siren size={16} /> {label}
      </button>
      <Modal open={open} title="Neue Lage anlegen" onClose={() => setOpen(false)}>
        {open && <IncidentForm submitLabel="Lage eröffnen" pending={start.isPending} onSubmit={(input) => start.mutate(input)} />}
      </Modal>
    </>
  );
}
