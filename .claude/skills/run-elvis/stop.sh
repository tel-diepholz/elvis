#!/usr/bin/env bash
# Beendet die mit start.sh gestartete Instanz (nur deren Ports, nie die Entwickler-Instanz auf 8080/5173).
for p in "${ELVIS_RUN_API_PORT:-8091}" "${ELVIS_RUN_WEB_PORT:-5183}"; do
  lsof -ti:"$p" -sTCP:LISTEN | xargs -r kill
done
echo "gestoppt"
