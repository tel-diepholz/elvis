import type { VideoConnect, VideoProvider, VideoSources, VideoStream, VideoStreamState } from '@elvis/shared';

/** Von einem Addon gemeldetes Gateway (provides.videoSources, Platzhalter bereits ersetzt) */
export interface VideoProvision {
  id: string;
  name: string;
  status: string;
  webrtc: string;
}

/** Status des Gateways (siehe addons/ndi-gateway/files/docker/gateway.py, addons/screencast/files/docker/receiver.py) */
interface GatewayStatus {
  encoder?: string;
  resolution?: string;
  problem?: string;
  sources?: string[];
  streams?: { name: string; path: string; state: string; error?: string; sender?: string | null; via?: string | null; connect?: VideoConnect }[];
}

const STATES: VideoStreamState[] = ['idle', 'starting', 'running', 'error'];

/** Nur Text-Felder übernehmen – der Status kommt aus dem Netz */
function connectOf(c: unknown): VideoConnect | undefined {
  if (!c || typeof c !== 'object') return undefined;
  const { airplay, shareUrl } = c as Record<string, unknown>;
  const out: VideoConnect = {};
  if (typeof airplay === 'string' && airplay) out.airplay = airplay.slice(0, 80);
  if (typeof shareUrl === 'string' && /^https?:\/\//.test(shareUrl)) out.shareUrl = shareUrl.slice(0, 300);
  return Object.keys(out).length ? out : undefined;
}

type Fetch = (url: string) => Promise<GatewayStatus>;

const defaultFetch: Fetch = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as GatewayStatus;
};

const POLL_MS = 5_000;

/** Videoquellen laufender Gateways – Ströme und Probleme für Kacheln und Auswahllisten */
export class VideoSourceService {
  private provisions: VideoProvision[] = [];
  private state = new Map<string, { online: boolean; status: GatewayStatus | null }>();
  private timer: NodeJS.Timeout | null = null;
  private lastKey = '';
  private readonly listeners = new Set<() => void>();

  constructor(private readonly fetchStatus: Fetch = defaultFetch) {}

  start(): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Gateways laufender Addons; liefert true, wenn sich etwas geändert hat */
  setProvisions(list: VideoProvision[]): boolean {
    if (JSON.stringify(list) === JSON.stringify(this.provisions)) return false;
    this.provisions = list;
    for (const id of this.state.keys()) if (!list.some((p) => p.id === id)) this.state.delete(id);
    void this.poll();
    return true;
  }

  list(): VideoSources {
    const providers: VideoProvider[] = [];
    const streams: VideoStream[] = [];
    for (const p of this.provisions) {
      const s = this.state.get(p.id);
      const status = s?.status ?? null;
      const streaming = new Set((status?.streams ?? []).map((x) => x.name));
      providers.push({
        id: p.id,
        name: p.name,
        online: !!s?.online,
        problem: s && !s.online ? 'Gateway antwortet nicht' : status?.problem || null,
        encoder: status?.encoder ?? null,
        resolution: status?.resolution ?? null,
        discovered: (status?.sources ?? []).filter((n) => !streaming.has(n)),
      });
      if (!s?.online) continue;
      for (const x of status?.streams ?? []) {
        const connect = connectOf(x.connect);
        streams.push({
          id: `${p.id}:${x.path}`,
          providerId: p.id,
          name: x.name,
          state: STATES.includes(x.state as VideoStreamState) ? (x.state as VideoStreamState) : 'error',
          error: x.error || null,
          url: `${p.webrtc.replace(/\/+$/, '')}/${encodeURIComponent(x.path)}`,
          // Felder der Bildschirmübertragung nur, wenn das Gateway sie meldet (NDI bleibt unverändert)
          ...(x.sender !== undefined && { sender: typeof x.sender === 'string' ? x.sender.slice(0, 80) : null }),
          ...(x.via !== undefined && { via: x.via === 'airplay' || x.via === 'browser' ? x.via : null }),
          ...(connect && { connect }),
        });
      }
    }
    return { providers, streams };
  }

  onChange(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private async poll(): Promise<void> {
    await Promise.all(
      this.provisions.map(async (p) => {
        try {
          this.state.set(p.id, { online: true, status: await this.fetchStatus(p.status) });
        } catch {
          this.state.set(p.id, { online: false, status: this.state.get(p.id)?.status ?? null });
        }
      }),
    );
    // Nur bei inhaltlicher Änderung melden (Zeitstempel des Gateways zählen nicht)
    const key = JSON.stringify(this.list());
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.listeners.forEach((l) => l());
    }
  }
}
