# ELVIS lite: öffnet ELVIS im Browser (Desktop-Verknüpfung) bzw. zeigt die Adressen für Tablets (-Adressen).
# Läuft der Server nicht, weil ein anderes Programm den Port belegt, gibt es eine klare Meldung.
param([switch]$Adressen)

$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName PresentationFramework
$title = 'ELVIS lite'
$dataDir = Join-Path $env:ProgramData 'ELVIS lite'
$port = 8222
$config = Join-Path $dataDir 'elvis.json'
if (Test-Path $config) {
  $p = (Get-Content $config -Raw | ConvertFrom-Json).port
  if ($p) { $port = [int]$p }
}

function Show([string]$text, [string]$icon = 'Information') {
  [void][System.Windows.MessageBox]::Show($text, $title, 'OK', $icon)
}

function Test-Elvis {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$port/api/info"
    return ($r.StatusCode -eq 200 -and $r.Content -match '"edition"')
  } catch { return $false }
}

if ($Adressen) {
  $ips = Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | ForEach-Object { "http://$($_.IPAddress):$port" }
  if ($ips) { Show ("Im Browser des Tablets öffnen:`n`n" + ($ips -join "`n") + "`n`nDas Tablet muss im selben Netz wie dieser Rechner sein.") }
  else { Show 'Dieser Rechner hat gerade keine Netzwerkverbindung.' 'Warning' }
  exit
}

if (-not (Test-Elvis)) {
  # Belegt ein fremdes Programm den Port, kann der Server nicht starten
  $listener = Get-NetTCPConnection -LocalPort $port -State Listen | Select-Object -First 1
  if ($listener) {
    $proc = Get-Process -Id $listener.OwningProcess
    $ours = $proc -and $proc.Path -and ($proc.Path -eq (Join-Path $PSScriptRoot 'node.exe'))
    if (-not $ours) {
      $name = if ($proc) { " ($($proc.ProcessName))" } else { '' }
      Show "Achtung: Port $port ist belegt$name. Der Server kann nicht starten.`n`nDas andere Programm beenden und den Dienst „ELVIS lite“ neu starten – oder in $config einen anderen Port eintragen." 'Error'
      exit 1
    }
  }
  # Dienst startet evtl. gerade (verzögerter Autostart nach dem Hochfahren): kurz warten
  $service = Get-Service 'elvis-lite'
  if (-not $service -or $service.Status -eq 'Stopped') {
    Show "Der ELVIS-Server läuft nicht.`n`nDienst „ELVIS lite“ in den Windows-Diensten starten. Protokolle: $dataDir\logs" 'Error'
    exit 1
  }
  $until = (Get-Date).AddSeconds(45)
  while (-not (Test-Elvis) -and (Get-Date) -lt $until) { Start-Sleep -Milliseconds 500 }
  if (-not (Test-Elvis)) {
    Show "Der ELVIS-Server antwortet nicht unter Port $port.`n`nProtokolle: $dataDir\logs" 'Error'
    exit 1
  }
}
Start-Process "http://localhost:$port/"
