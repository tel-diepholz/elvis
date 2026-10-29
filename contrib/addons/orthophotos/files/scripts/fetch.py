#!/usr/bin/env python3
"""Lädt Orthophoto-Dateien (GeoTIFF/JP2) aus dem Verzeichnis-Index eines Bundeslandes.

Umgebung: STATES (kommagetrennt), FEED_OVERRIDE (id=url,id=url), FILTER (Regex auf Dateinamen), MAX_FILES, REFRESH.
Fortschritt: Zeilen „ELVIS_PROGRESS <prozent> <text>“.
"""
import json, os, re, shutil, sys, urllib.parse, urllib.request

DATA = '/data'
EXT = re.compile(r'\.(tif|tiff|jp2)$', re.I)
HREF = re.compile(r'href="([^"]+)"', re.I)


def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'ELVIS-orthophotos/1.0'})
    return urllib.request.urlopen(req, timeout=60)


def links(index):
    html = get(index).read().decode('utf-8', 'replace')
    out = set()
    for h in HREF.findall(html):
        full = urllib.parse.urljoin(index, h)
        if EXT.search(urllib.parse.urlparse(full).path):
            out.add(full)
    return sorted(out)


def main():
    catalog = {s['id']: s for s in json.load(open(f'{DATA}/addon/catalog.json'))['states']}
    states = [s for s in os.environ.get('STATES', '').split(',') if s]
    override = dict(p.split('=', 1) for p in os.environ.get('FEED_OVERRIDE', '').split(',') if '=' in p)
    flt = re.compile(os.environ['FILTER']) if os.environ.get('FILTER') else None
    limit = int(os.environ.get('MAX_FILES') or 0)
    refresh = os.environ.get('REFRESH') == 'true'
    if not states:
        sys.exit('Kein Bundesland gewählt')
    jobs = []
    for sid in states:
        if sid not in catalog:
            sys.exit(f'Unbekanntes Bundesland: {sid}')
        feed = override.get(sid) or catalog[sid]['feed']
        if not feed:
            sys.exit(f"Für {catalog[sid]['name']} ist keine Download-Adresse hinterlegt. Index-Adresse in „feedOverride“ angeben (Portal: {catalog[sid]['portal']}).")
        urls = [u for u in links(feed) if not flt or flt.search(os.path.basename(u))]
        if limit:
            urls = urls[:limit]
        print(f"{catalog[sid]['name']}: {len(urls)} Dateien", flush=True)
        jobs += [(sid, u) for u in urls]
    for i, (sid, url) in enumerate(jobs):
        d = f'{DATA}/src/{sid}'
        os.makedirs(d, exist_ok=True)
        dest = f'{d}/{os.path.basename(urllib.parse.urlparse(url).path)}'
        if not refresh and os.path.exists(dest):
            continue
        with get(url) as r, open(dest + '.part', 'wb') as f:
            shutil.copyfileobj(r, f)
        os.replace(dest + '.part', dest)
        print(f'ELVIS_PROGRESS {int(100 * (i + 1) / len(jobs))} {os.path.basename(dest)}', flush=True)


main()
