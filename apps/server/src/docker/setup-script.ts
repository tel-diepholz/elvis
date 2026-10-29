/**
 * Shell-Skript, das auf einem Host Docker-TLS einrichtet. Es wird einmalig über einen Token
 * abgerufen und enthält CA, Server-Zertifikat und -Schlüssel.
 */
export function renderSetupScript(p: { caPem: string; certPem: string; keyPem: string; port: number; callbackUrl: string; hostName: string }): string {
  // Heredocs mit 'EOF' – Zertifikatsinhalte werden nicht von der Shell interpretiert.
  return `#!/bin/sh
# ELVIS – Docker-TLS-Einrichtung für Host "${p.hostName.replace(/[^\w .-]/g, '')}"
set -eu

TLS_DIR=/etc/docker/tls
PORT=${p.port}
CALLBACK='${p.callbackUrl}'

fail() { echo "FEHLER: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "Bitte als root ausführen (z. B. mit sudo)."
IS_WSL=0
grep -qi microsoft /proc/version 2>/dev/null && IS_WSL=1

if ! command -v dockerd >/dev/null 2>&1; then
  if [ "$IS_WSL" -eq 1 ] && command -v docker >/dev/null 2>&1; then
    fail "Hier ist nur die WSL-Integration von Docker Desktop vorhanden. Deren Engine läuft außerhalb dieser WSL-Distribution und lässt sich nicht für TLS einrichten. Bitte Docker Engine direkt in der Distribution installieren und die Docker-Desktop-Integration für sie abschalten (siehe ELVIS-Doku docs/addons/README.md, 'Docker-Host unter Windows/WSL')."
  fi
  fail "Docker Engine (dockerd) ist nicht installiert – z. B. mit: curl -fsSL https://get.docker.com | sudo sh"
fi
if ! command -v systemctl >/dev/null 2>&1 || [ ! -d /run/systemd/system ]; then
  if [ "$IS_WSL" -eq 1 ]; then
    fail "systemd läuft in dieser WSL-Distribution nicht. In /etc/wsl.conf eintragen:  [boot]  systemd=true  – danach in Windows 'wsl --shutdown' ausführen und die Distribution neu starten."
  fi
  fail "systemd wird benötigt."
fi

if [ -f /etc/docker/daemon.json ] && grep -Eq '"(hosts|tls|tlsverify|tlscacert|tlscert|tlskey)"' /etc/docker/daemon.json; then
  fail "/etc/docker/daemon.json enthält bereits hosts/tls-Einstellungen. Bitte entfernen oder in ELVIS 'Eigene Zertifikate' verwenden."
fi

echo "==> Zertifikate nach $TLS_DIR schreiben"
mkdir -p "$TLS_DIR"
chmod 700 "$TLS_DIR"
cat > "$TLS_DIR/ca.pem" <<'ELVIS_EOF'
${p.caPem.trim()}
ELVIS_EOF
cat > "$TLS_DIR/server-cert.pem" <<'ELVIS_EOF'
${p.certPem.trim()}
ELVIS_EOF
umask 077
cat > "$TLS_DIR/server-key.pem" <<'ELVIS_EOF'
${p.keyPem.trim()}
ELVIS_EOF
chmod 600 "$TLS_DIR/server-key.pem"

echo "==> dockerd um TLS-Port $PORT erweitern (systemd-Override)"
ORIG=$(systemctl show docker -p ExecStart --value | sed -n 's/.*argv\\[\\]=\\([^;]*\\);.*/\\1/p' | head -n1 | sed 's/[[:space:]]*$//')
[ -n "$ORIG" ] || fail "ExecStart von docker.service konnte nicht ermittelt werden."
# Frühere ELVIS-Optionen entfernen (Skript ist wiederholbar, z. B. zur Zertifikatserneuerung).
BASE=$(echo "$ORIG" | sed -e 's# -H tcp://0.0.0.0:[0-9]*##g' -e 's# --tlsverify##g' -e 's# --tls[a-z]*=/etc/docker/tls/[^ ]*##g')
mkdir -p /etc/systemd/system/docker.service.d
cat > /etc/systemd/system/docker.service.d/elvis-tls.conf <<ELVIS_EOF
# Von ELVIS angelegt – Docker-Engine-API per TLS (gegenseitige Zertifikatsprüfung)
[Service]
ExecStart=
ExecStart=$BASE -H tcp://0.0.0.0:$PORT --tlsverify --tlscacert=$TLS_DIR/ca.pem --tlscert=$TLS_DIR/server-cert.pem --tlskey=$TLS_DIR/server-key.pem
ELVIS_EOF

echo "==> Docker neu starten"
systemctl daemon-reload
systemctl restart docker

i=0
while [ $i -lt 30 ]; do
  if ss -ltn 2>/dev/null | grep -q ":$PORT "; then break; fi
  i=$((i + 1)); sleep 1
done
ss -ltn 2>/dev/null | grep -q ":$PORT " || fail "Docker lauscht nicht auf Port $PORT – siehe 'journalctl -u docker'."

echo "==> ELVIS benachrichtigen"
if curl -fsS -X POST "$CALLBACK" >/dev/null 2>&1; then
  echo "Fertig. Der Host erscheint in ELVIS als verbunden."
else
  echo "Fertig. ELVIS war nicht erreichbar – im Assistenten 'Verbindung testen' wählen."
fi
echo "Hinweis: Port $PORT per Firewall nur aus dem Fahrzeug-LAN erreichbar machen."
`;
}
