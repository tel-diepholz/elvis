#!/bin/sh
# Installiert ELVIS auf diesem Server (Docker-Container) und bindet den Server selbst als
# Docker-Host per TLS an. Aufruf aus dem Projektverzeichnis:  sudo sh deploy/install.sh
#   --no-docker-host   Server nicht als Docker-Host einrichten
set -eu

fail() { echo "FEHLER: $*" >&2; exit 1; }
SETUP_HOST=1
[ "${1:-}" = "--no-docker-host" ] && SETUP_HOST=0

[ "$(id -u)" -eq 0 ] || fail "Bitte als root ausführen (z. B. mit sudo)."
command -v docker >/dev/null 2>&1 || fail "Docker ist nicht installiert."
docker compose version >/dev/null 2>&1 || fail "Docker Compose (Plugin) fehlt."
cd "$(dirname "$0")/.."

# Anpassungen dieses Fahrzeugs (nicht im Git), siehe deploy/compose.override.example.yaml
COMPOSE="-f deploy/compose.yaml"
if [ -f deploy/compose.override.yaml ]; then
  COMPOSE="$COMPOSE -f deploy/compose.override.yaml"
  echo "==> Mit Anpassungen aus deploy/compose.override.yaml"
fi

echo "==> ELVIS bauen und starten"
# shellcheck disable=SC2086
docker compose $COMPOSE up -d --build

echo "==> Warten, bis ELVIS bereit ist"
i=0
until curl -fsS http://127.0.0.1:8080/api/health >/dev/null 2>&1; do
  i=$((i + 1)); [ $i -lt 60 ] || fail "ELVIS startet nicht – siehe 'docker logs elvis'."
  sleep 1
done

JAR=$(mktemp)
trap 'rm -f "$JAR"' EXIT
# JSON sicher erzeugen/auslesen – mit dem Node im ELVIS-Container (kein jq nötig).
jsonify() { docker exec -i elvis node -e 'const [k,...v]=process.argv.slice(1);const o={};k.split(",").forEach((x,i)=>o[x]=x==="userId"?Number(v[i]):v[i]);console.log(JSON.stringify(o))' "$@"; }
jget() { docker exec -i elvis node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const v=new Function("d","return d"+process.argv[1])(JSON.parse(d));console.log(typeof v==="object"?JSON.stringify(v):v)})' "$1"; }
read_pin() { # Prompt, Variable
  printf '%s' "$1"; stty -echo 2>/dev/null || true; read -r "$2"; stty echo 2>/dev/null || true; echo
}

if [ "$SETUP_HOST" -eq 1 ]; then
  if [ "$(curl -fsS http://127.0.0.1:8080/api/auth/status | jget .hasUsers)" = "false" ]; then
    echo "==> Ersten Admin anlegen"
    printf 'Vorname: '; read -r FN
    printf 'Nachname: '; read -r LN
    while :; do
      read_pin 'PIN (4 Ziffern): ' PIN
      read_pin 'PIN wiederholen: ' PIN2
      echo "$PIN" | grep -Eq '^[0-9]{4}$' && [ "$PIN" = "$PIN2" ] && break
      echo "PIN ungültig oder nicht identisch – bitte erneut."
    done
    curl -fsS -c "$JAR" -H 'content-type: application/json' -d "$(jsonify firstName,lastName,pin "$FN" "$LN" "$PIN")" \
      http://127.0.0.1:8080/api/auth/setup >/dev/null || fail "Admin konnte nicht angelegt werden."
  else
    echo "==> Als Admin anmelden"
    curl -fsS http://127.0.0.1:8080/api/auth/candidates | jget '.map(u=>u.id+": "+u.firstName+" "+u.lastName).join("\n")'
    printf 'Nummer: '; read -r UID_SEL
    read_pin 'PIN: ' PIN
    curl -fsS -c "$JAR" -H 'content-type: application/json' -d "$(jsonify userId,pin "$UID_SEL" "$PIN")" \
      http://127.0.0.1:8080/api/auth/login >/dev/null || fail "Anmeldung fehlgeschlagen."
  fi

  ADDR=$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')
  [ -n "$ADDR" ] || fail "LAN-Adresse dieses Servers nicht ermittelbar – mit --no-docker-host installieren und Host in ELVIS anlegen."
  NAME=$(hostname -s)
  echo "==> Diesen Server ($NAME, $ADDR) als Docker-Host anmelden"
  RESP=$(curl -fsS -b "$JAR" -X POST -H 'content-type: application/json' \
    -d "{\"certMode\":\"elvis\",\"name\":\"$NAME\",\"address\":\"$ADDR\"}" http://127.0.0.1:8080/api/docker/hosts) \
    || fail "Anmeldung fehlgeschlagen (existiert der Host schon? Dann in ELVIS 'Zertifikat erneuern')."
  URL=$(echo "$RESP" | sed -n 's/.*"command":"curl -fsS \([^ ]*\) .*/\1/p')
  [ -n "$URL" ] || fail "Unerwartete Antwort: $RESP"
  # Docker startet dabei neu – ELVIS kommt über restart: unless-stopped zurück und prüft den Host selbst.
  curl -fsS "$URL" | sh
fi

echo
echo "ELVIS läuft: http://$(hostname -I 2>/dev/null | awk '{print $1}'):8080"
