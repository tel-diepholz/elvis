#!/usr/bin/env bash
# Startet eine isolierte ELVIS-Instanz (Server + Vite) neben einer evtl. laufenden Entwickler-Instanz:
# eigene Ports, frisches Datenverzeichnis, SMTP aus. Legt den ersten Admin an und schreibt das Sitzungs-Cookie.
# Aufruf aus dem Repo-Wurzelverzeichnis:  .claude/skills/run-elvis/start.sh [--incident]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
RUN="${ELVIS_RUN_DIR:-${TMPDIR:-/tmp}/elvis-run}"
API_PORT="${ELVIS_RUN_API_PORT:-8091}"
WEB_PORT="${ELVIS_RUN_WEB_PORT:-5183}"

for p in "$API_PORT" "$WEB_PORT"; do
  if lsof -ti:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $p ist belegt – erst .claude/skills/run-elvis/stop.sh" >&2
    exit 1
  fi
done

rm -rf "$RUN" && mkdir -p "$RUN/data"
(cd "$ROOT/apps/server" && PORT="$API_PORT" ELVIS_DATA_DIR="$RUN/data" ELVIS_SCAN_PORT=off nohup npx tsx src/index.ts >"$RUN/server.log" 2>&1 &)
(cd "$ROOT/apps/web" && ELVIS_BACKEND="http://localhost:$API_PORT" nohup npx vite --port "$WEB_PORT" --strictPort >"$RUN/web.log" 2>&1 &)

timeout 90 bash -c "until curl -sf http://localhost:$API_PORT/api/health >/dev/null && curl -sf http://localhost:$WEB_PORT >/dev/null; do sleep 1; done" || {
  echo "Start fehlgeschlagen – siehe $RUN/server.log und $RUN/web.log" >&2
  exit 1
}

# Erster Admin (Ersteinrichtung) → Sitzungs-Cookie
curl -s -i -X POST "http://localhost:$API_PORT/api/auth/setup" -H 'content-type: application/json' \
  -d '{"firstName":"Test","lastName":"Admin","pin":"4711"}' |
  sed -n 's/^[Ss]et-[Cc]ookie: elvis_session=\([^;]*\).*/\1/p' | tr -d '\r' >"$RUN/cookie"
[ -s "$RUN/cookie" ] || { echo "Kein Sitzungs-Cookie erhalten" >&2; exit 1; }

if [ "${1:-}" = "--incident" ]; then
  curl -s -o /dev/null -X POST "http://localhost:$API_PORT/api/incidents" -H "cookie: elvis_session=$(cat "$RUN/cookie")" \
    -H 'content-type: application/json' -d '{"title":"Übung","keyword":"TH"}'
fi

echo "ELVIS läuft: Web http://localhost:$WEB_PORT  API http://localhost:$API_PORT  Daten $RUN"
