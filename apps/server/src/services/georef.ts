import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, readSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type Docker from 'dockerode';
import tar from 'tar-stream';
import {
  GEOREF_MAX_PAGES,
  extensionOf,
  fitAffine,
  georefRequestSchema,
  overlayZoom,
  type GeorefBackground,
  type GeorefCut,
  type GeorefPoint,
  type GeorefStroke,
  type GeorefJob,
  type GeorefPage,
  type GeorefStatus,
  type MapObject,
  type OverlayData,
  type Topic,
} from '@elvis/shared';
import type { z } from 'zod';
import type { HostService } from '../docker/hosts.js';
import { describeError } from '../docker/hosts.js';
import { followLogs } from '../addons/jobs.js';
import { HttpError } from '../errors.js';
import type { DocumentService } from './documents.js';
import type { IncidentService } from './incidents.js';

/** GDAL mit PDF-Treiber (poppler) und gdal2tiles.py; wird beim ersten Gebrauch auf den Docker-Host geladen */
export const GEOREF_IMAGE = 'ghcr.io/osgeo/gdal:ubuntu-full-3.9.2';
/** Auflösung der gerenderten Seiten; große Formate werden auf GEOREF_MAX_PX begrenzt */
const RENDER_DPI = 200;
const GEOREF_MAX_PX = 8000;
/** So viele erledigte Läufe bleiben abrufbar */
const KEEP_JOBS = 50;

/** Seiten eines PDFs als PNG (und Vorschaubild) rendern; die Seitenzahl liefert gdalinfo über die Subdatasets */
const RENDER_SCRIPT = `set -eu
cd /tmp/work
mkdir -p out
n=$(gdalinfo in.pdf 2>/dev/null | grep -c 'SUBDATASET_[0-9]*_NAME=' || true)
single=0
if [ "$n" -eq 0 ]; then n=1; single=1; fi
if [ "$n" -gt ${GEOREF_MAX_PAGES} ]; then n=${GEOREF_MAX_PAGES}; fi
i=1
while [ "$i" -le "$n" ]; do
  if [ "$single" -eq 1 ]; then src=in.pdf; else src="PDF:$i:in.pdf"; fi
  echo "ELVIS_PROGRESS $((i * 100 / (n + 1))) Seite $i von $n"
  # Seitengröße bei 72 dpi = Punkt; DPI so wählen, dass die längere Kante höchstens ${GEOREF_MAX_PX} Pixel hat
  dpi=$(gdalinfo --config GDAL_PDF_DPI 72 "$src" | awk -v max=${GEOREF_MAX_PX} -v want=${RENDER_DPI} '/^Size is/ { gsub(",", "", $3); m = ($3 > $4 ? $3 : $4); d = int(max * 72 / m); print (d < want ? d : want) }')
  gdal_translate -q -of PNG --config GDAL_PDF_DPI "$dpi" "$src" "out/$i.png"
  gdal_translate -q -of PNG -outsize 240 0 "out/$i.png" "out/$i.thumb.png"
  i=$((i + 1))
done
echo "ELVIS_PROGRESS 100 Fertig"
`;

/**
 * Seite vorbereiten, bevor sie in die Karte geht (Einstellungen aus prep.json, siehe GeorefPrep): Seite als RGBA-GeoTIFF
 * (Palette und Graustufen werden aufgefüllt), dann Alpha auf 0 in weggeschnittenen Rechtecken (überall) sowie für
 * Hintergrundfarbe und Radierer außerhalb des Gebäudeumrisses (ohne Umriss: überall); innerhalb liegt die Seite deckend
 * auf der Hintergrundfarbe. Umriss und Pinselstriche rastert
 * OGR in Bildpixeln (Geotransformation 0,1,0,0,0,1 – y nach unten). Gleiche Regel wie isBackground() in der Vorschau.
 */
const PREP_SCRIPT = `echo "ELVIS_PROGRESS 2 Seite vorbereiten"
python3 - <<'PY'
import json
import numpy as np
from osgeo import gdal, ogr
gdal.UseExceptions()
cfg = json.load(open('prep.json'))
src = gdal.Open('page.png')
if src.GetRasterBand(1).GetColorTable() is not None:
    src = gdal.Translate('/vsimem/rgba.tif', src, rgbExpand='rgba')
bands = [src.GetRasterBand(i + 1).ReadAsArray() for i in range(src.RasterCount)]
rgb = bands[:3] if len(bands) >= 3 else [bands[0]] * 3
alpha = bands[3 if len(bands) >= 3 else 1].copy() if len(bands) in (2, 4) else np.full(bands[0].shape, 255, dtype=np.uint8)
w, h = src.RasterXSize, src.RasterYSize

def rasterize(geoms):
    mask = gdal.GetDriverByName('MEM').Create('', w, h, 1, gdal.GDT_Byte)
    mask.SetGeoTransform((0, 1, 0, 0, 0, 1))
    ds = ogr.GetDriverByName('Memory').CreateDataSource('')
    layer = ds.CreateLayer('m')
    for g in geoms:
        f = ogr.Feature(layer.GetLayerDefn())
        f.SetGeometry(g)
        layer.CreateFeature(f)
    gdal.RasterizeLayer(mask, [1], layer, burn_values=[1])
    return mask.GetRasterBand(1).ReadAsArray().astype(bool)

def wkt(points):
    return ', '.join(f'{x} {y}' for x, y in points)

outline = cfg['outline']
inside = rasterize([ogr.CreateGeometryFromWkt(f'POLYGON(({wkt(outline + outline[:1])}))')]) if outline else np.zeros((h, w), dtype=bool)
remove = np.zeros((h, w), dtype=bool)
bg = cfg['background']
if bg:
    c = int(bg['color'][1:], 16)
    diff = np.maximum.reduce([np.abs(rgb[i].astype(np.int16) - ((c >> s) & 255)) for i, s in enumerate((16, 8, 0))])
    remove |= diff <= bg['tolerance']
strokes = []
for st in cfg['erase']:
    pts = st['points']
    line = ogr.CreateGeometryFromWkt(f'LINESTRING({wkt(pts)})' if len(pts) > 1 else f'POINT({pts[0][0]} {pts[0][1]})')
    strokes.append(line.Buffer(st['width'] / 2))
if strokes:
    remove |= rasterize(strokes)
remove &= ~inside
if bg and outline:
    # Gebäude deckend auf der Hintergrundfarbe (transparente PDF-Seiten wären innen sonst durchsichtig)
    a = alpha.astype(np.float32) / 255
    rgb = [np.where(inside, np.round(rgb[i] * a + ((c >> s) & 255) * (1 - a)), rgb[i]).astype(np.uint8) for i, s in enumerate((16, 8, 0))]
    alpha = np.where(inside, 255, alpha).astype(np.uint8)
for x0, y0, x1, y1 in cfg['cuts']:
    remove[y0:y1, x0:x1] = True
alpha[remove] = 0
out = gdal.GetDriverByName('GTiff').Create('page.tif', w, h, 4, gdal.GDT_Byte, ['COMPRESS=DEFLATE', 'PHOTOMETRIC=RGB', 'ALPHA=YES'])
for i, b in enumerate(rgb + [alpha]):
    out.GetRasterBand(i + 1).WriteArray(b)
out = None
PY
`;

/** Was PREP_SCRIPT aus prep.json liest */
export interface GeorefPrep {
  cuts: GeorefCut[];
  outline: GeorefPoint[] | null;
  background: GeorefBackground | null;
  erase: GeorefStroke[];
}

const needsPrep = (p: GeorefPrep) => p.cuts.length > 0 || !!p.background || p.erase.length > 0;

/** Seite mit Passpunkten entzerren (Web-Mercator) und als XYZ-Kacheln schneiden */
function tileScript(gcps: { x: number; y: number; lat: number; lon: number }[], prep: boolean, order: 1 | 2, minZoom: number, maxZoom: number): string {
  // Nur geprüfte Zahlen landen im Skript
  const gcpArgs = gcps.map((p) => `-gcp ${p.x.toFixed(2)} ${p.y.toFixed(2)} ${p.lon.toFixed(8)} ${p.lat.toFixed(8)}`).join(' ');
  const src = prep ? 'page.tif' : 'page.png';
  return `set -eu
cd /tmp/work
${prep ? PREP_SCRIPT : ''}echo "ELVIS_PROGRESS 5 Passpunkte setzen"
gdal_translate -q -of VRT -a_srs EPSG:4326 ${gcpArgs} ${src} gcp.vrt
echo "ELVIS_PROGRESS 15 Entzerren"
gdalwarp -q -t_srs EPSG:3857 -order ${order} -r bilinear -dstalpha -co COMPRESS=DEFLATE -co TILED=YES gcp.vrt warped.tif
echo "ELVIS_PROGRESS 40 Kacheln schneiden (Zoom ${minZoom}–${maxZoom})"
gdal2tiles.py --xyz -q -w none -r bilinear --processes=2 -z ${minZoom}-${maxZoom} warped.tif out
echo "ELVIS_PROGRESS 100 Fertig"
`;
}

/** Breite und Höhe aus dem IHDR-Block einer PNG-Datei */
export function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24 || buf.toString('latin1', 1, 4) !== 'PNG') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function pngSizeOf(path: string): { width: number; height: number } {
  const head = Buffer.alloc(24);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, head, 0, 24, 0);
  } finally {
    closeSync(fd);
  }
  return pngSize(head) ?? { width: 100_000, height: 100_000 };
}

/** Nordwestecke einer XYZ-Kachel */
function tileCorner(z: number, x: number, y: number): { lat: number; lon: number } {
  const n = 2 ** z;
  return { lat: (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI, lon: (x / n) * 360 - 180 };
}

async function tarOf(files: { name: string; data: Buffer | string }[]): Promise<Buffer> {
  const pack = tar.pack();
  pack.entry({ name: 'work/', type: 'directory', mode: 0o777 });
  for (const f of files) pack.entry({ name: `work/${f.name}`, mode: 0o644 }, f.data);
  pack.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of pack as unknown as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** Dateien aus einem Tar-Strom, die zum Muster passen (Pfad relativ zum Archivwurzel-Ordner) */
async function untar(stream: NodeJS.ReadableStream, onFile: (path: string, data: Buffer) => Promise<void>): Promise<void> {
  const extract = tar.extract();
  stream.pipe(extract);
  for await (const entry of extract) {
    const chunks: Buffer[] = [];
    for await (const c of entry) chunks.push(Buffer.from(c as Buffer));
    if (entry.header.type === 'file') await onFile(entry.header.name, Buffer.concat(chunks));
  }
}

type Job = GeorefJob & { tail: string[] };

/**
 * Werkzeug „PDF in Karte integrieren“: rendert PDF-Seiten und kachelt eine georeferenzierte Seite mit GDAL in einem
 * kurzlebigen Container auf einem verbundenen Docker-Host. Ein- und Ausgabe laufen per Tar über die Engine-API (keine
 * Bind-Mounts – ELVIS und der Docker-Host teilen kein Dateisystem). Läufe stehen nur im Speicher und laufen
 * nacheinander; die Kacheln liegen unter dataDir/overlays/<Kartenobjekt>.
 */
export class GeorefService {
  private readonly jobs = new Map<string, Job>();
  private queue: Promise<void> = Promise.resolve();
  private readonly cacheDir: string;
  readonly overlayDir: string;

  constructor(
    private readonly deps: {
      dataDir: string;
      documents: DocumentService;
      incidents: IncidentService;
      hosts: HostService | null;
      notify: (topics: Topic[]) => void;
    },
  ) {
    this.cacheDir = join(deps.dataDir, 'georef');
    this.overlayDir = join(deps.dataDir, 'overlays');
    deps.incidents.onMapObjectRemoved((o) => {
      if (o.kind === 'overlay') void rm(this.tilesDir(o.id), { recursive: true, force: true });
    });
  }

  status(): GeorefStatus {
    if (!this.deps.hosts) return { available: false, reason: 'Docker ist in ELVIS abgeschaltet' };
    if (!this.deps.hosts.list().some((h) => h.status === 'ready')) return { available: false, reason: 'Kein Docker-Host verbunden (System → Docker)' };
    return { available: true, reason: null };
  }

  job(id: string): GeorefJob {
    const j = this.jobs.get(id);
    if (!j) throw new HttpError(404, 'Lauf nicht gefunden (ELVIS wurde vielleicht neu gestartet)');
    const { tail: _tail, ...job } = j;
    return job;
  }

  tilesDir(objectId: number): string {
    return join(this.overlayDir, String(objectId));
  }

  /** Kachel eines Overlays (null = gibt es nicht) */
  async tile(objectId: number, z: number, x: number, y: number): Promise<Buffer | null> {
    return readFile(join(this.tilesDir(objectId), String(z), String(x), `${y}.png`)).catch(() => null);
  }

  // --- Seiten ---

  private pdf(docId: number, viewerId: number | null) {
    const doc = this.deps.documents.visibleDocument(docId, viewerId);
    if (doc.mimeType !== 'application/pdf' && extensionOf(doc.filename) !== 'pdf') throw new HttpError(400, 'Nur PDF-Dokumente lassen sich in die Karte übernehmen');
    return doc;
  }

  /** Cache der gerenderten Seiten; eine neue Fassung des Dokuments rendert neu */
  private pagesDir(doc: { id: number; version: number }): string {
    return join(this.cacheDir, `${doc.id}-v${doc.version}`);
  }

  async pages(docId: number, viewerId: number | null): Promise<GeorefPage[] | null> {
    const doc = this.pdf(docId, viewerId);
    const raw = await readFile(join(this.pagesDir(doc), 'pages.json'), 'utf8').catch(() => null);
    return raw ? (JSON.parse(raw) as GeorefPage[]) : null;
  }

  pagePath(docId: number, viewerId: number | null, page: number, thumb: boolean): string {
    const doc = this.pdf(docId, viewerId);
    const path = join(this.pagesDir(doc), `${page}${thumb ? '.thumb' : ''}.png`);
    if (!existsSync(path)) throw new HttpError(404, `Seite ${page} ist nicht gerendert`);
    return path;
  }

  renderPages(docId: number, viewerId: number | null): GeorefJob {
    const doc = this.pdf(docId, viewerId);
    this.requireHost();
    const dir = this.pagesDir(doc);
    return this.enqueue('pages', doc.id, async (job) => {
      if (existsSync(join(dir, 'pages.json'))) return;
      const input = await readFile(doc.path);
      const pages: GeorefPage[] = [];
      const tmp = `${dir}.tmp-${job.id}`;
      await mkdir(tmp, { recursive: true });
      try {
        await this.runContainer(job, RENDER_SCRIPT, [{ name: 'in.pdf', data: input }], async (path, data) => {
          const m = /^out\/(\d+)(\.thumb)?\.png$/.exec(path);
          if (!m) return;
          await writeFile(join(tmp, `${m[1]}${m[2] ?? ''}.png`), data);
          const size = !m[2] && pngSize(data);
          if (size) pages.push({ page: Number(m[1]), ...size });
        });
        if (!pages.length) throw new Error('Das PDF enthält keine lesbaren Seiten');
        pages.sort((a, b) => a.page - b.page);
        await writeFile(join(tmp, 'pages.json'), JSON.stringify(pages));
        // Ältere Fassungen desselben Dokuments verwerfen
        for (const name of await readdir(this.cacheDir)) if (name.startsWith(`${doc.id}-`) && join(this.cacheDir, name) !== tmp) await rm(join(this.cacheDir, name), { recursive: true, force: true });
        await rename(tmp, dir);
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    });
  }

  // --- Overlay ---

  createOverlay(docId: number, viewerId: number | null, input: z.output<typeof georefRequestSchema>, operator: string): GeorefJob {
    const doc = this.pdf(docId, viewerId);
    if (this.deps.incidents.get(doc.incidentId).closedAt) throw new HttpError(409, 'Einsatz ist abgeschlossen und kann nicht mehr geändert werden');
    const pagePath = this.pagePath(docId, viewerId, input.page, false);
    const fit = fitAffine(input.gcps);
    if (!fit) throw new HttpError(400, 'Die Passpunkte liegen (fast) auf einer Linie – bitte weiter verteilt setzen');
    const { minZoom, maxZoom } = overlayZoom(fit.t);
    // Bereiche auf die Seite begrenzen; was außerhalb liegt, fällt weg
    const size = pngSizeOf(pagePath);
    const cuts = input.cuts
      .map(([x0, y0, x1, y1]): GeorefCut => [Math.min(x0, size.width), Math.min(y0, size.height), Math.min(x1, size.width), Math.min(y1, size.height)])
      .filter(([x0, y0, x1, y1]) => x1 > x0 && y1 > y0);
    const prep: GeorefPrep = { cuts, outline: input.outline, background: input.background, erase: input.erase };
    this.requireHost();
    return this.enqueue('overlay', doc.id, async (job) => {
      const tmp = join(this.overlayDir, `tmp-${job.id}`);
      let created: MapObject | null = null;
      try {
        // Ausdehnung aus den Kacheln der feinsten Stufe (passt auch bei Entzerrung 2. Ordnung)
        const span = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
        await this.runContainer(job, tileScript(input.gcps, needsPrep(prep), input.order, minZoom, maxZoom), [
          { name: 'page.png', data: await readFile(pagePath) },
          { name: 'prep.json', data: Buffer.from(JSON.stringify(prep)) },
        ], async (path, data) => {
          const m = /^out\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(path);
          if (!m) return;
          const [z, x, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
          const out = join(tmp, String(z), String(x), `${y}.png`);
          await mkdir(dirname(out), { recursive: true });
          await writeFile(out, data);
          if (z !== maxZoom) return;
          span.x0 = Math.min(span.x0, x);
          span.x1 = Math.max(span.x1, x);
          span.y0 = Math.min(span.y0, y);
          span.y1 = Math.max(span.y1, y);
        });
        if (!Number.isFinite(span.x0)) throw new Error('GDAL hat keine Kacheln erzeugt');
        const nw = tileCorner(maxZoom, span.x0, span.y0);
        const se = tileCorner(maxZoom, span.x1 + 1, span.y1 + 1);
        const data: OverlayData = {
          documentId: doc.id,
          filename: doc.filename,
          page: input.page,
          bounds: [
            [se.lat, nw.lon],
            [nw.lat, se.lon],
          ],
          minZoom,
          maxZoom,
          opacity: 0.8,
          gcps: input.gcps,
          rmsM: Math.round(fit.rmsM * 10) / 10,
          cuts,
          outline: input.outline,
          background: input.background,
          erased: input.erase.length,
        };
        created = this.deps.incidents.addMapObject(doc.incidentId, { kind: 'overlay', name: input.name, lat: (nw.lat + se.lat) / 2, lon: (nw.lon + se.lon) / 2, data }, operator);
        await rename(tmp, this.tilesDir(created.id));
        job.objectId = created.id;
      } catch (err) {
        if (created) this.deps.incidents.removeMapObject(created.id, operator);
        throw err;
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    });
  }

  // --- Ablauf ---

  private requireHost(): void {
    const s = this.status();
    if (!s.available) throw new HttpError(409, s.reason ?? 'Werkzeug nicht verfügbar');
  }

  private enqueue(kind: GeorefJob['kind'], documentId: number, work: (job: Job) => Promise<void>): GeorefJob {
    const job: Job = { id: randomUUID(), kind, documentId, state: 'queued', message: 'Wartet', percent: null, objectId: null, tail: [] };
    this.jobs.set(job.id, job);
    for (const id of [...this.jobs.keys()].slice(0, Math.max(0, this.jobs.size - KEEP_JOBS))) this.jobs.delete(id);
    this.queue = this.queue.then(async () => {
      this.update(job, { state: 'running', message: 'Startet' });
      try {
        await work(job);
        this.update(job, { state: 'done', message: 'Fertig', percent: 100 });
      } catch (err) {
        const detail = job.tail.length ? ` – ${job.tail.slice(-3).join(' / ')}` : '';
        this.update(job, { state: 'failed', message: `${describeError(err)}${detail}` });
      }
    });
    this.deps.notify(['georef']);
    return this.job(job.id);
  }

  private update(job: Job, patch: Partial<GeorefJob>): void {
    Object.assign(job, patch);
    this.deps.notify(['georef']);
  }

  private docker(): Docker {
    const host = this.deps.hosts?.list().find((h) => h.status === 'ready');
    if (!host) throw new Error('Kein Docker-Host verbunden');
    return this.deps.hosts!.readyClient(host.id).docker;
  }

  /** Skript in einem frischen GDAL-Container ausführen; Ergebnis unter /tmp/work/out kommt per onFile zurück */
  private async runContainer(job: Job, script: string, files: { name: string; data: Buffer }[], onFile: (path: string, data: Buffer) => Promise<void>): Promise<void> {
    const docker = this.docker();
    if (!(await docker.getImage(GEOREF_IMAGE).inspect().then(() => true, () => false))) {
      this.update(job, { message: 'GDAL-Image wird geladen (einmalig, ca. 1,5 GB)' });
      await new Promise<void>((resolve, reject) =>
        docker.pull(GEOREF_IMAGE, (err: Error | null, stream: NodeJS.ReadableStream) =>
          err ? reject(err) : docker.modem.followProgress(stream, (e: Error | null) => (e ? reject(e) : resolve())),
        ),
      );
    }
    const container = await docker.createContainer({
      name: `elvis-georef-${job.id.slice(0, 8)}`,
      Image: GEOREF_IMAGE,
      Cmd: ['sh', '-c', script],
      Labels: { 'elvis.tool': 'georef' },
      HostConfig: { NetworkMode: 'none', LogConfig: { Type: 'json-file', Config: { 'max-size': '1m' } } },
    });
    try {
      await container.putArchive(await tarOf(files), { path: '/tmp' });
      await container.start();
      const logs = followLogs(docker, container, (line) => {
        const m = /^ELVIS_PROGRESS (\d+) (.*)$/.exec(line);
        if (m) this.update(job, { percent: Number(m[1]), message: m[2]! });
        else job.tail = [...job.tail, line].slice(-10);
      }).catch(() => undefined);
      const result = (await container.wait()) as { StatusCode: number };
      await logs;
      if (result.StatusCode !== 0) throw new Error(`GDAL mit Code ${result.StatusCode} beendet`);
      this.update(job, { message: 'Ergebnis übernehmen' });
      const out = (await container.getArchive({ path: '/tmp/work/out' })) as NodeJS.ReadableStream;
      await untar(out, onFile);
    } finally {
      await container.remove({ force: true }).catch(() => undefined);
    }
  }
}
