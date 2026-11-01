import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { Loading } from '../../components/ui';
import { DocView } from '../../components/docs/DocView';

/** Anleitung eines Addons (manifest.docs) – rohes HTML wird nicht ausgegeben */
export function AddonDocs({ id }: { id: string }) {
  const { data, error } = useQuery({ queryKey: ['addons', 'docs', id], queryFn: () => api.addonDocs(id), staleTime: 300_000 });
  if (error) return <p className="muted">Anleitung nicht verfügbar: {error.message}</p>;
  if (!data) return <Loading />;
  return (
    <div className="addon-docs">
      <DocView markdown={data.markdown} />
    </div>
  );
}
