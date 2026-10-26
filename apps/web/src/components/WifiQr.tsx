import { useMemo } from 'react';
import qrcode from 'qrcode-generator';
import { wifiQrPayload } from '@elvis/shared';

// Netznamen mit Umlauten: als UTF-8 kodieren (Vorgabe der Bibliothek ist Latin-1)
qrcode.stringToBytes = (s: string) => Array.from(new TextEncoder().encode(s));

/** QR-Code für beliebigen Text; skaliert verlustfrei als SVG, weiß hinterlegt (auch im dunklen Schema lesbar) */
export function QrCode({ data, label, className }: { data: string; label: string; className?: string }) {
  const { size, path } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(data);
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) d += `M${x + 2},${y + 2}h1v1h-1z`;
    return { size: n + 4, path: d };
  }, [data]);
  return (
    <svg className={className} viewBox={`0 0 ${size} ${size}`} shapeRendering="crispEdges" role="img" aria-label={label}>
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

/** QR-Code zum Verbinden mit einem WLAN */
export function WifiQr({ ssid, password, className }: { ssid: string; password: string; className?: string }) {
  return <QrCode data={wifiQrPayload(ssid, password)} label={`QR-Code für WLAN ${ssid}`} className={className} />;
}
