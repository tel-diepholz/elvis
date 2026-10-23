/**
 * Mittelwind und Böen aus Einzelmessungen, angelehnt an die meteorologische Praxis (WMO):
 * Mittelwind = Mittel über 2 min, Böe = höchster 3-Sekunden-Mittelwert der letzten 10 min.
 * Die Richtung wird vektoriell gemittelt (sonst ergäbe 350° und 10° fälschlich 180°).
 */
const MEAN_MS = 2 * 60_000;
const GUST_WINDOW_MS = 10 * 60_000;
const GUST_AVG_MS = 3_000;

interface Sample {
  t: number;
  speed: number;
  dir: number | null;
}

export class WindStatistics {
  private samples: Sample[] = [];
  private gusts: { t: number; v: number }[] = [];

  add(t: number, speed: number, dirDeg: number | null): void {
    this.samples.push({ t, speed, dir: dirDeg });
    this.samples = this.samples.filter((s) => t - s.t <= GUST_WINDOW_MS);
    // 3-Sekunden-Fenster: bei 1 Hz genau drei Messwerte (t-2 s … t)
    const recent = this.samples.filter((s) => t - s.t < GUST_AVG_MS);
    const avg3 = recent.reduce((a, s) => a + s.speed, 0) / recent.length;
    this.gusts.push({ t, v: avg3 });
    this.gusts = this.gusts.filter((g) => t - g.t <= GUST_WINDOW_MS);
  }

  /** Mittelwind, Böe und mittlere Richtung zum Zeitpunkt t (null ohne Messwerte). */
  values(t: number): { meanMs: number | null; gustMs: number | null; directionDeg: number | null } {
    const mean = this.samples.filter((s) => t - s.t <= MEAN_MS);
    if (!mean.length) return { meanMs: null, gustMs: null, directionDeg: null };
    const meanMs = mean.reduce((a, s) => a + s.speed, 0) / mean.length;
    const gustMs = Math.max(meanMs, ...this.gusts.filter((g) => t - g.t <= GUST_WINDOW_MS).map((g) => g.v));
    const withDir = mean.filter((s) => s.dir !== null);
    let directionDeg: number | null = null;
    if (withDir.length) {
      // gewichtet mit der Geschwindigkeit: Böen bestimmen die Richtung stärker als Flauten
      let x = 0;
      let y = 0;
      for (const s of withDir) {
        const r = (s.dir! * Math.PI) / 180;
        x += Math.cos(r) * Math.max(s.speed, 0.1);
        y += Math.sin(r) * Math.max(s.speed, 0.1);
      }
      directionDeg = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
    }
    return { meanMs, gustMs, directionDeg };
  }
}
