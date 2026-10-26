import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Trash2, Upload } from 'lucide-react';
import { DISPLAY_IMAGE_MAX_BYTES, DISPLAY_TEXT_MAX, DISPLAY_TILE_TYPES, tilesOverlap, type DisplayLayout, type DisplayScreen, type DisplayTile } from '@elvis/shared';
import { api } from '../../lib/api';
import { fmtBytes } from '../../lib/format';
import { useDevice } from '../../lib/live';
import { useToast } from '../../lib/toast';
import { Field, Segmented, Toggle } from '../ui';
import { DEFAULT_SCREEN } from './DisplayCanvas';
import { TILE_ICONS } from './tiles';

type Box = Pick<DisplayTile, 'x' | 'y' | 'w' | 'h'>;
interface Drag {
  id: string;
  mode: 'move' | 'resize';
  /** Abstand des Griffpunkts zur linken oberen Ecke der Kachel (in Zellen) */
  offX: number;
  offY: number;
  box: Box;
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** Kurzbeschreibung der Einstellungen für die Kachel im Editor */
function useTileSummary() {
  const cams = useDevice('cameras')?.state.cameras ?? [];
  const { data: videos } = useQuery({ queryKey: ['videoSources'], queryFn: api.videoSources });
  const { data: images } = useQuery({ queryKey: ['displays', 'images'], queryFn: api.displayImages });
  return (t: DisplayTile) => {
    if (t.type === 'image') return typeof t.config.imageId === 'number' ? (images?.find((i) => i.id === t.config.imageId)?.name ?? 'Bild fehlt') : 'kein Bild';
    if (t.type === 'video') return videos?.streams.find((s) => s.id === t.config.streamId)?.name ?? (t.config.streamId ? 'Quelle nicht verfügbar' : 'erste Quelle');
    if (t.type === 'camera') return cams.find((c) => c.id === t.config.cameraId)?.name ?? (t.config.cameraId ? 'Kamera fehlt' : 'erste Kamera');
    if (t.type === 'text') {
      const text = String(t.config.text ?? '').trim();
      return text ? (text.length > 40 ? `${text.slice(0, 40)} …` : text) : 'kein Text';
    }
    if (t.type === 'guestWifi') return String(t.config.title ?? '').trim() || 'Gastnetz des Einsatzes';
    if (t.type === 'tasks') return t.config.personal === true ? 'mit persönlichen Aufgaben' : 'ohne persönliche Aufgaben';
    if (t.type === 'forces') return [t.config.subunits !== false ? 'mit Untereinheiten' : 'nur oberste Ebene', t.config.planned === true && 'mit geplanten'].filter(Boolean).join(', ');
    if (t.type === 'forecast') return t.config.range === '24h' ? '24 Stunden' : t.config.range === '7d' ? '7 Tage' : '24 Stunden und 7 Tage';
    if (t.type === 'scenes') return t.config.theme !== false ? 'mit Hell/Dunkel' : 'nur Szenen';
    if (t.type === 'map') return `${t.config.center === 'incident' ? 'Einsatzort' : 'Fahrzeug'}${t.config.follow !== false ? ', mitgeführt' : ''}`;
    return '';
  };
}

/**
 * Kacheln im Raster verschieben (ziehen) und in der Größe ändern (Ecke ziehen); Pfeiltasten verschieben,
 * Umschalt+Pfeiltasten ändern die Größe. Überlappende Positionen werden rot angezeigt und nicht übernommen.
 */
export function GridEditor({
  layout,
  screen,
  selectedId,
  onSelect,
  onChange,
}: {
  layout: DisplayLayout;
  screen: DisplayScreen | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChange: (layout: DisplayLayout) => void;
}) {
  const grid = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const summary = useTileSummary();
  const s = screen ?? DEFAULT_SCREEN;

  const cellAt = (e: PointerEvent) => {
    const r = grid.current!.getBoundingClientRect();
    return { cx: Math.floor(((e.clientX - r.left) / r.width) * layout.cols), cy: Math.floor(((e.clientY - r.top) / r.height) * layout.rows) };
  };
  const fits = (id: string, b: Box) => b.x >= 0 && b.y >= 0 && b.x + b.w <= layout.cols && b.y + b.h <= layout.rows && !layout.tiles.some((t) => t.id !== id && tilesOverlap(t, b));
  const commit = (id: string, b: Box) => {
    if (fits(id, b)) onChange({ ...layout, tiles: layout.tiles.map((t) => (t.id === id ? { ...t, ...b } : t)) });
  };

  const start = (t: DisplayTile, mode: Drag['mode']) => (e: PointerEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    onSelect(t.id);
    grid.current!.setPointerCapture(e.pointerId);
    const { cx, cy } = cellAt(e);
    setDrag({ id: t.id, mode, offX: cx - t.x, offY: cy - t.y, box: { x: t.x, y: t.y, w: t.w, h: t.h } });
  };
  const move = (e: PointerEvent) => {
    if (!drag) return;
    const t = layout.tiles.find((x) => x.id === drag.id)!;
    const { cx, cy } = cellAt(e);
    const box =
      drag.mode === 'move'
        ? { x: clamp(cx - drag.offX, 0, layout.cols - t.w), y: clamp(cy - drag.offY, 0, layout.rows - t.h), w: t.w, h: t.h }
        : { x: t.x, y: t.y, w: clamp(cx - t.x + 1, 1, layout.cols - t.x), h: clamp(cy - t.y + 1, 1, layout.rows - t.y) };
    if (JSON.stringify(box) !== JSON.stringify(drag.box)) setDrag({ ...drag, box });
  };
  const end = () => {
    if (drag) commit(drag.id, drag.box);
    setDrag(null);
  };
  const onKey = (t: DisplayTile) => (e: KeyboardEvent) => {
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!d) return;
    e.preventDefault();
    commit(t.id, e.shiftKey ? { x: t.x, y: t.y, w: t.w + d[0]!, h: t.h + d[1]! } : { x: t.x + d[0]!, y: t.y + d[1]!, w: t.w, h: t.h });
  };

  return (
    <div className="grid-editor" style={{ aspectRatio: `${s.width} / ${s.height}`, ['--display-ratio' as string]: s.width / s.height }}>
      <div
        ref={grid}
        className="grid-editor-area"
        style={{ backgroundSize: `${100 / layout.cols}% ${100 / layout.rows}%` }}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={() => setDrag(null)}
        onPointerDown={() => onSelect(null)}
      >
        {layout.tiles.map((t) => {
          const b = drag?.id === t.id ? drag.box : t;
          const Icon = TILE_ICONS[t.type];
          const invalid = drag?.id === t.id && !fits(t.id, drag.box);
          return (
            <div
              key={t.id}
              role="button"
              tabIndex={0}
              aria-label={`${DISPLAY_TILE_TYPES[t.type].label}, Spalte ${t.x + 1}, Zeile ${t.y + 1}, ${t.w}×${t.h}`}
              className={`grid-editor-tile ${selectedId === t.id ? 'selected' : ''} ${invalid ? 'invalid' : ''} ${drag?.id === t.id ? 'dragging' : ''}`}
              style={{ left: `${(b.x / layout.cols) * 100}%`, top: `${(b.y / layout.rows) * 100}%`, width: `${(b.w / layout.cols) * 100}%`, height: `${(b.h / layout.rows) * 100}%` }}
              onPointerDown={start(t, 'move')}
              onKeyDown={onKey(t)}
              onFocus={() => onSelect(t.id)}
            >
              <Icon size={22} />
              <strong>{DISPLAY_TILE_TYPES[t.type].label}</strong>
              <span className="cell-sub">{summary(t)}</span>
              <span className="cell-sub">
                {b.w}×{b.h}
              </span>
              <span className="grid-editor-resize" aria-hidden onPointerDown={start(t, 'resize')} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Einstellungen der gewählten Kachel */
export function TileSettings({ tile, onChange, onRemove }: { tile: DisplayTile; onChange: (config: DisplayTile['config']) => void; onRemove: () => void }) {
  const cams = useDevice('cameras')?.state.cameras ?? [];
  const { data: sources = [] } = useQuery({ queryKey: ['mapSources'], queryFn: api.mapSources, staleTime: Infinity, enabled: tile.type === 'map' });
  const set = (k: string, v: string | number | boolean) => onChange({ ...tile.config, [k]: v });
  const info = DISPLAY_TILE_TYPES[tile.type];

  return (
    <div className="tile-settings">
      <h3 className="section-title">{info.label}</h3>
      <p className="muted">{info.description}</p>
      {tile.type === 'camera' && (
        <Field label="Kamera">
          <select value={String(tile.config.cameraId ?? '')} onChange={(e) => set('cameraId', e.target.value)}>
            <option value="">Erste Kamera</option>
            {cams.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      {tile.type === 'map' && (
        <>
          <Field label="Kartenstil">
            <select value={String(tile.config.sourceId ?? '')} onChange={(e) => set('sourceId', e.target.value)}>
              <option value="">Automatisch (dunkel)</option>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Mittelpunkt">
            <Segmented
              label="Mittelpunkt"
              value={tile.config.center === 'incident' ? 'incident' : 'vehicle'}
              onChange={(v) => set('center', v)}
              options={[
                { value: 'vehicle', label: 'Fahrzeug' },
                { value: 'incident', label: 'Einsatzort' },
              ]}
            />
          </Field>
          <Toggle label="Karte mitführen" checked={tile.config.follow !== false} onChange={(on) => set('follow', on)} />
          <Field label={`Zoomstufe (${Number(tile.config.zoom) || 15})`}>
            <input type="range" min={8} max={19} value={Number(tile.config.zoom) || 15} onChange={(e) => set('zoom', Number(e.target.value))} />
          </Field>
          <p className="field-hint">Mit „mitführen“ folgt die Karte Fahrzeug bzw. Einsatzort und lässt sich nicht verschieben. Ohne Mitführen lässt sie sich am Bildschirm per Touch und unter „Bildschirme“ in der Vorschau verschieben und zoomen; der Bildschirm behält den zuletzt eingestellten Ausschnitt, auch nach „Neu laden“.</p>
        </>
      )}
      {tile.type === 'video' && <VideoTileSettings tile={tile} set={set} />}
      {tile.type === 'image' && <ImageTileSettings tile={tile} set={set} />}
      {tile.type === 'text' && (
        <>
          <Field label="Text">
            <textarea
              value={String(tile.config.text ?? '')}
              onChange={(e) => set('text', e.target.value.slice(0, DISPLAY_TEXT_MAX))}
              rows={5}
              maxLength={DISPLAY_TEXT_MAX}
              placeholder="z. B. Atemschutz-Sammelplatz: Parkplatz Nord"
            />
          </Field>
          <Field label="Ausrichtung">
            <Segmented
              label="Ausrichtung"
              value={tile.config.align === 'left' ? 'left' : 'center'}
              onChange={(v) => set('align', v)}
              options={[
                { value: 'center', label: 'Zentriert' },
                { value: 'left', label: 'Links' },
              ]}
            />
          </Field>
          <Field label="Hervorhebung">
            <Segmented
              label="Hervorhebung"
              value={String(tile.config.tone ?? 'normal')}
              onChange={(v) => set('tone', v)}
              options={[
                { value: 'normal', label: 'Normal' },
                { value: 'info', label: 'Hinweis' },
                { value: 'warn', label: 'Warnung' },
                { value: 'alarm', label: 'Alarm' },
              ]}
            />
          </Field>
          <p className="field-hint">Die Schriftgröße passt sich automatisch an, sodass der Text die Kachel ausfüllt.</p>
        </>
      )}
      {tile.type === 'guestWifi' && (
        <>
          <Field label="Überschrift" hint="optional, z. B. „Gäste-WLAN“">
            <input value={String(tile.config.title ?? '')} onChange={(e) => set('title', e.target.value.slice(0, 60))} maxLength={60} />
          </Field>
          <p className="field-hint">Zeigt Netzname, Passwort und QR-Code des Gastnetzes, solange ein Einsatz läuft. Einrichten unter Einstellungen → WLAN-Accesspoints.</p>
        </>
      )}
      {tile.type === 'forecast' && (
        <>
          <Field label="Zeitraum">
            <Segmented
              label="Zeitraum"
              value={tile.config.range === '24h' || tile.config.range === '7d' ? tile.config.range : 'both'}
              onChange={(v) => set('range', v)}
              options={[
                { value: 'both', label: 'Beides' },
                { value: '24h', label: '24 Stunden' },
                { value: '7d', label: '7 Tage' },
              ]}
            />
          </Field>
          <p className="field-hint">Prognose von Open-Meteo am Fahrzeugstandort (GPS der Wetterstation, sonst Einsatzort). Böen über der Sturmwarnschwelle sind rot.</p>
        </>
      )}
      {tile.type === 'tasks' && (
        <>
          <Toggle label="Persönliche Aufgaben anzeigen" checked={tile.config.personal === true} onChange={(on) => set('personal', on)} />
          <p className="field-hint">
            Zeigt alle offenen Aufgaben des laufenden Einsatzes nach Fälligkeit. Persönliche Aufgaben hat sich ein Benutzer selbst zugewiesen – sie erscheinen nur, wenn
            hier eingeschaltet.
          </p>
        </>
      )}
      {tile.type === 'forces' && (
        <>
          <Toggle label="Untereinheiten anzeigen" checked={tile.config.subunits !== false} onChange={(on) => set('subunits', on)} />
          <Toggle label="Geplante Einheiten anzeigen" checked={tile.config.planned === true} onChange={(on) => set('planned', on)} />
          <p className="field-hint">
            Zeigt die Kräfte des laufenden Einsatzes nach Einsatzabschnitten mit Status und Stärke; Einheiten mit Untereinheiten mit der Summe. Entlassene erscheinen
            nicht.
          </p>
        </>
      )}
      {tile.type === 'scenes' && (
        <>
          <Toggle label="Umschalter Hell/Dunkel anzeigen" checked={tile.config.theme !== false} onChange={(on) => set('theme', on)} />
          <p className="field-hint">
            Zeigt die gespeicherten Szenen dieses Bildschirms zum Antippen; die angezeigte ist hervorgehoben. Die Kachel in jede Szene aufnehmen – sonst lässt sich am
            Bildschirm nicht zurückwechseln. Das Design gilt für den ganzen Bildschirm und lässt sich auch unter „Bildschirme“ in der Vorschau umschalten.
          </p>
        </>
      )}
      {(tile.type === 'clock' || tile.type === 'weather' || tile.type === 'alerts' || tile.type === 'network') && <p className="muted">Keine weiteren Einstellungen.</p>}
      <button type="button" className="btn" onClick={onRemove}>
        <Trash2 size={16} /> Kachel entfernen
      </button>
    </div>
  );
}

function ImageTileSettings({ tile, set }: { tile: DisplayTile; set: (k: string, v: string | number | boolean) => void }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const { data: images = [] } = useQuery({ queryKey: ['displays', 'images'], queryFn: api.displayImages });
  const current = typeof tile.config.imageId === 'number' ? tile.config.imageId : null;
  const selected = images.find((i) => i.id === current);
  const upload = useMutation({
    mutationFn: api.uploadDisplayImage,
    onSuccess: (img) => set('imageId', img.id),
    onError: (e) => toast('error', e.message),
  });
  const remove = useMutation({
    mutationFn: api.removeDisplayImage,
    onSuccess: () => set('imageId', ''),
    onError: (e) => toast('error', e.message),
  });
  const choose = (file: File | undefined) => {
    if (!file) return;
    if (file.size > DISPLAY_IMAGE_MAX_BYTES) toast('error', `Bild größer als ${fmtBytes(DISPLAY_IMAGE_MAX_BYTES)}`);
    else upload.mutate(file);
  };
  return (
    <>
      {current !== null && (
        <div className="tile-image-preview">
          <img src={api.displayImageUrl(current)} alt={selected?.name ?? ''} />
        </div>
      )}
      <Field label="Bild">
        <select value={current ?? ''} onChange={(e) => set('imageId', e.target.value ? Number(e.target.value) : '')}>
          <option value="">Kein Bild</option>
          {current !== null && !selected && <option value={current}>Bild fehlt</option>}
          {images.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name} ({fmtBytes(i.sizeBytes)})
            </option>
          ))}
        </select>
      </Field>
      <span className="btn-row">
        <input ref={input} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e) => (choose(e.target.files?.[0]), (e.target.value = ''))} />
        <button type="button" className="btn" disabled={upload.isPending} onClick={() => input.current?.click()}>
          <Upload size={16} /> {upload.isPending ? 'Lädt hoch …' : 'Bild hochladen'}
        </button>
        {selected && (
          <button
            type="button"
            className="btn"
            disabled={remove.isPending || selected.uses > 0}
            title={selected.uses > 0 ? `Wird noch in ${selected.uses} gespeicherten Kachel(n) oder Szenen angezeigt` : 'Bild endgültig löschen'}
            onClick={() => window.confirm(`Bild „${selected.name}“ löschen?`) && remove.mutate(selected.id)}
          >
            <Trash2 size={16} /> Bild löschen
          </button>
        )}
      </span>
      <Field label="Darstellung">
        <Segmented
          label="Darstellung"
          value={tile.config.fit === 'cover' ? 'cover' : 'contain'}
          onChange={(v) => set('fit', v)}
          options={[
            { value: 'contain', label: 'Ganz zeigen' },
            { value: 'cover', label: 'Kachel füllen' },
          ]}
        />
      </Field>
      <p className="field-hint">
        PNG, JPEG, GIF oder WebP bis {fmtBytes(DISPLAY_IMAGE_MAX_BYTES)}. „Ganz zeigen“ passt das Bild ein, „Kachel füllen“ schneidet die Ränder ab. Hochgeladene Bilder
        stehen allen Bildschirmen zur Auswahl.
      </p>
    </>
  );
}

function VideoTileSettings({ tile, set }: { tile: DisplayTile; set: (k: string, v: string | number | boolean) => void }) {
  const { data } = useQuery({ queryKey: ['videoSources'], queryFn: api.videoSources });
  const streams = data?.streams ?? [];
  const current = String(tile.config.streamId ?? '');
  return (
    <>
      <Field label="Quelle">
        <select value={current} onChange={(e) => set('streamId', e.target.value)}>
          <option value="">Erste verfügbare Quelle</option>
          {current && !streams.some((s) => s.id === current) && <option value={current}>{current.split(':').pop()} (derzeit nicht verfügbar)</option>}
          {streams.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </Field>
      <Toggle label="Ton" checked={tile.config.audio === true} onChange={(on) => set('audio', on)} />
      {data && !data.providers.length && <p className="field-hint">Für NDI-Quellen unter Verwaltung → Addons das „NDI-Gateway“ installieren.</p>}
      {data?.providers.map((p) =>
        p.problem ? (
          <p key={p.id} className="field-error">
            {p.name}: {p.problem}
          </p>
        ) : (
          <p key={p.id} className="field-hint">
            {p.name}: {p.encoder ?? '–'}, {p.resolution ?? '–'}
            {p.discovered.length ? ` · weitere Quellen ohne Strom: ${p.discovered.join(', ')}` : ''}
          </p>
        ),
      )}
      <p className="field-hint">
        Der Bildschirm muss den Docker-Host direkt erreichen (WebRTC). Ton: Browser starten Ton erst nach einer Bedienung – bis dahin läuft das Bild stumm mit Knopf „Ton
        einschalten“. Kiosk-Browser mit <code>--autoplay-policy=no-user-gesture-required</code> spielen Ton sofort.
      </p>
    </>
  );
}
