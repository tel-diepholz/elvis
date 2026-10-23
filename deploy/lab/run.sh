#!/bin/sh
# Ende-zu-Ende-Test der Docker-/Addon-Verwaltung gegen echte Docker-Daemons.
#   sh deploy/lab/run.sh [--keep]     (--keep: Labor danach nicht abbauen)
set -eu
cd "$(dirname "$0")"
API=http://127.0.0.1:18080/api
KEEP=${1:-}

fail() { echo "FEHLER: $*" >&2; exit 1; }
ok() { echo "  ✓ $*"; }
json() { node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const v=new Function("d","return d"+process.argv[1])(JSON.parse(d));console.log(typeof v==="object"?JSON.stringify(v):v)})' "$1"; }
JAR=$(mktemp)
api() { curl -fsS -b "$JAR" -c "$JAR" -H 'content-type: application/json' "$@"; }
pem() { docker compose exec -T "$1" cat "/certs/client/$2" | awk '{printf "%s\\n", $0}'; }
cleanup() { rm -f "$JAR"; [ "$KEEP" = "--keep" ] || docker compose down -v >/dev/null 2>&1 || true; }
trap cleanup EXIT

wait_status() { # addon, jq-Pfad, Sollwert, Sekunden
  i=0
  while [ "$(api "$API/addons/$1" | json "$2")" != "$3" ]; do
    i=$((i + 1)); [ $i -lt "$4" ] || fail "$1: $2 ist nicht '$3' – $(api "$API/addons/$1" | json '.error')"
    sleep 1
  done
}

echo "==> Labor starten"
docker compose up -d --build
i=0; until curl -fsS "$API/health" >/dev/null 2>&1; do i=$((i+1)); [ $i -lt 90 ] || fail "ELVIS startet nicht"; sleep 1; done
for s in server1 server2; do
  i=0; until docker compose exec -T "$s" test -f /certs/client/key.pem 2>/dev/null; do i=$((i+1)); [ $i -lt 60 ] || fail "$s ohne TLS"; sleep 1; done
done
ok "ELVIS und beide Docker-Daemons laufen"

api -X POST "$API/auth/setup" -d '{"firstName":"Labor","lastName":"Admin","pin":"2580"}' >/dev/null
ok "Admin angelegt und angemeldet"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$API/addons")" = 401 ] || fail "Addon-Verwaltung ohne Anmeldung erreichbar"

echo "==> Docker-Hosts anlegen (eigene Zertifikate der dind-Container)"
add_host() { # name, ca-quelle, client-quelle
  api -X POST "$API/docker/hosts" -d "{\"certMode\":\"custom\",\"name\":\"$1\",\"address\":\"$1\",\"caPem\":\"$(pem "$2" ca.pem)\",\"certPem\":\"$(pem "$3" cert.pem)\",\"keyPem\":\"$(pem "$3" key.pem)\"}"
}
H1=$(add_host server1 server1 server1 | json '.host')
H2=$(add_host server2 server2 server2 | json '.host')
[ "$(echo "$H1" | json '.status')" = ready ] || fail "server1 nicht verbunden: $(echo "$H1" | json '.error')"
[ "$(echo "$H2" | json '.status')" = ready ] || fail "server2 nicht verbunden: $(echo "$H2" | json '.error')"
H2_ID=$(echo "$H2" | json '.id')
ok "server1 und server2 per TLS verbunden ($(echo "$H2" | json '.dockerVersion'), $(echo "$H2" | json '.arch'))"

BAD=$(add_host fremd server1 server2 | json '.host.status')
[ "$BAD" != ready ] || fail "Client-Zertifikat einer fremden CA wurde akzeptiert"
ok "Fremdes Client-Zertifikat abgewiesen"

echo "==> hello auf server2 installieren"
api -X POST "$API/addons" -d "{\"addonId\":\"hello\",\"hostId\":$H2_ID,\"options\":{\"name\":\"ELW Labor\",\"port\":8099}}" >/dev/null
wait_status hello .status running 240
docker compose exec -T server2 wget -qO- http://127.0.0.1:8099 | grep -q "Name: ELW Labor" || fail "Webserver antwortet nicht wie erwartet"
ok "Installiert, Webserver antwortet mit konfiguriertem Namen"

api -X PATCH "$API/addons/hello" -d '{"options":{"name":"Neu konfiguriert","port":8099,"verbose":false}}' >/dev/null
sleep 2; wait_status hello .status running 60
docker compose exec -T server2 wget -qO- http://127.0.0.1:8099 | grep -q "Name: Neu konfiguriert" || fail "Neukonfiguration nicht wirksam"
ok "Neukonfiguration wirksam"

api -X POST "$API/addons/hello/jobs/stamp" >/dev/null
wait_status hello '.jobs[0].state' succeeded 120
api "$API/addons/hello/logs?target=job:stamp" | grep -q "Neu konfiguriert" || fail "Job-Protokoll ohne erwarteten Inhalt"
api "$API/addons/hello/logs?target=web" | grep -qi "port" || fail "Container-Protokoll leer"
ok "Job ausgeführt, Protokolle lesbar"

echo "==> Image-Übertragung server1 → server2"
docker compose exec -T server1 sh -c 'docker pull -q alpine:3.20 >/dev/null && docker tag alpine:3.20 elvis-lab/only-on-server1:1'
api -X POST "$API/addons" -d "{\"addonId\":\"transfer-test\",\"hostId\":$H2_ID,\"options\":{}}" >/dev/null
wait_status transfer-test .status running 120
ok "Image ohne Registry von server1 übertragen"

echo "==> Deinstallieren"
api -X DELETE "$API/addons/hello?data=1" >/dev/null
api -X DELETE "$API/addons/transfer-test?data=1" >/dev/null
[ -z "$(docker compose exec -T server2 docker ps -aq --filter label=elvis.managed)" ] || fail "Container nach Deinstallation übrig"
[ -z "$(docker compose exec -T server2 docker volume ls -q --filter label=elvis.managed)" ] || fail "Volumes nach Deinstallation übrig"
ok "Container und Volumes entfernt"

echo
echo "Labor erfolgreich."
