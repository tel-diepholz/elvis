import { phoneKey, type AddonOption, type DeviceId, type OptionValues, type SystemId } from '@elvis/shared';
import type { DeviceAdapter } from './adapter.js';
import { BluezScanner } from './bluetooth/bluez.js';
import { AirmarAdapter } from './drivers/airmar.js';
import { BluetoothAdapter, SimScanner, type BluetoothSource } from './drivers/bluetooth.js';
import { CamerasAdapter, type CameraSource } from './drivers/cameras.js';
import { MonitoringAdapter, type MonitoringSource } from './drivers/monitoring.js';
import { OpenWrtWifiAdapter, type WifiSource } from './drivers/openwrt.js';
import { RADIOS_PATTERN, ReichertZbeAdapter, parseRadios } from './drivers/reichert/adapter.js';
import { DEFAULT_PORT as ZBE_PORT } from './drivers/reichert/protocol.js';
import { TeltonikaAdapter } from './drivers/teltonika.js';
import { TRUNKS_PATTERN, YeastarTgAdapter, parseTrunks } from './drivers/yeastar/adapter.js';
import { DEFAULT_PORT as TG_PORT } from './drivers/yeastar/protocol.js';
import { MediaSim } from './sim/media.js';
import { NetworkSim } from './sim/network.js';
import { RadioSim } from './sim/radio.js';
import { RouterSim } from './sim/router.js';
import { TelephonySim } from './sim/telephony.js';
import { MessengerSim } from './sim/messenger.js';
import { SignalCliAdapter } from './drivers/signal/adapter.js';
import { TelegramAdapter } from './drivers/telegram/adapter.js';
import { WhatsAppCloudAdapter } from './drivers/whatsapp/cloud.js';
import { ThreemaGatewayAdapter } from './drivers/threema/gateway.js';
import type { DriverVault, HookSource, MessengerBus } from './messaging/bus.js';
import type { MessengerProvisions } from './messaging/provisions.js';
import type { TelephonyBus } from './telephony/bus.js';
import { WeatherSim } from './sim/weather.js';

export interface DriverDefinition<K extends DeviceId> {
  label: string;
  description: string;
  /** Einstellungen des Treibers; daraus entsteht das Formular in den Einstellungen. */
  options: Record<string, AddonOption>;
  create(options: OptionValues, deps: DriverDeps): DeviceAdapter<K>;
}

/** Dienste, die Treiber brauchen können (z. B. die Kameraliste aus den Einstellungen) */
export interface DriverDeps {
  cameras: CameraSource;
  /** Accesspoints aus den Einstellungen (WLAN) */
  wifi: WifiSource;
  /** Ziele des Monitorings aus den Einstellungen */
  monitoring: MonitoringSource;
  /** Bluetooth-Geräte aus den Einstellungen */
  bluetooth: BluetoothSource;
  /** Eingehende SMS und beendete Gespräche an SMS-Postfach und Anrufliste */
  telephony: TelephonyBus;
  /** Eingehende Nachrichten und Zustellbestätigungen der Messenger an die Nachrichten */
  messenger: MessengerBus;
  /** Ablage für Treiber (Sitzungen, Schlüssel) */
  vault: DriverVault;
  /** Webhooks über das Cloud-Relay */
  hooks: HookSource;
  /** Hilfsdienste der Messenger aus Addons (signal-cli) */
  messengerServices: MessengerProvisions;
}

export interface DeviceDefinition<K extends DeviceId> {
  name: string;
  system: SystemId;
  drivers: Record<string, DriverDefinition<K>>;
}

const wanNameOption: AddonOption = {
  type: 'string',
  label: 'Bezeichnung des WAN-Ports',
  required: true,
  default: 'WAN',
  maxLength: 40,
  help: 'Erscheint in der Oberfläche statt „WAN“, z. B. „LAN Feuerwache“ oder „Einspeisung Gerätehaus“.',
};

const sim = <K extends DeviceId>(create: (options: OptionValues) => DeviceAdapter<K>): DriverDefinition<K> => ({
  label: 'Simulation',
  description: 'Simulierte Werte zum Testen und Vorführen.',
  options: {},
  create,
});

const messengerSim = (name: string) => ({
  label: 'Simulation',
  description: `Simuliertes ${name}-Konto: Senden klappt nach einer Sekunde, danach „zugestellt“ und „gelesen“. Gelegentlich kommt eine Nachricht. Eine Nachricht mit „#fehler“ im Text schlägt fehl.`,
  options: {},
});

/**
 * Treiber je Fahrzeugmodul. Weitere Treiber (z. B. andere Wetterstationen) hier eintragen –
 * sie erscheinen automatisch in der Treiberauswahl der Einstellungen.
 */
export const DEVICE_DEFINITIONS: { [K in DeviceId]: DeviceDefinition<K> } = {
  router: {
    name: 'ELW-Router',
    system: 'comms',
    drivers: {
      sim: { ...sim((o) => new RouterSim({ wanName: String(o.wanName || 'WAN') })), options: { wanName: wanNameOption } },
      'teltonika-rutos': {
        label: 'Teltonika RutOS (z. B. RUTM59)',
        description:
          'Teltonika-Router mit RutOS ab Firmware 7.x über die Web-API. Zeigt den SIM-Status beider Steckplätze, den Failover-Zustand und den WAN-Port. Nur lesend – am Router wird nichts verändert.',
        options: {
          wanName: wanNameOption,
          host: { type: 'string', label: 'Adresse des Routers', required: true, default: '192.168.1.1', help: 'IP-Adresse oder Hostname im Fahrzeugnetz.' },
          protocol: {
            type: 'select',
            label: 'Protokoll',
            required: false,
            default: 'https',
            choices: [
              { value: 'https', label: 'HTTPS (Standard ab RutOS 7.15)' },
              { value: 'http', label: 'HTTP' },
            ],
          },
          username: { type: 'string', label: 'Benutzer', required: true, default: 'admin', help: 'Am besten einen eigenen Benutzer mit Leserechten im Router anlegen (ohne Zwei-Faktor-Anmeldung).' },
          password: { type: 'password', label: 'Passwort', required: true },
          verifyTls: { type: 'bool', label: 'Zertifikat prüfen', required: false, default: false, help: 'Nur einschalten, wenn der Router ein gültiges Zertifikat hat – ab Werk ist es selbstsigniert.' },
          pollSeconds: { type: 'int', label: 'Abfrageintervall (Sekunden)', required: false, default: 5, min: 2, max: 300 },
          wanInterface: { type: 'string', label: 'WAN-Schnittstelle im Router', required: false, default: 'wan', help: 'Nur ändern, wenn der WAN-Port im Router anders heißt.' },
        },
        create: (o) =>
          new TeltonikaAdapter({
            host: o.host,
            protocol: o.protocol,
            username: o.username,
            password: o.password,
            verifyTls: o.verifyTls,
            wanName: o.wanName,
            wanInterface: o.wanInterface || 'wan',
            pollSeconds: Number(o.pollSeconds),
          }),
      },
    },
  },
  cameras: {
    name: 'Kameras',
    system: 'media',
    drivers: {
      standard: {
        label: 'Kameras aus den Einstellungen',
        description: 'Zeigt und bedient die unter „Kameras“ eingetragenen Kameras (z. B. Axis über VAPIX). Kameratyp und Zugangsdaten werden je Kamera eingestellt.',
        options: {},
        create: (_o, deps) => new CamerasAdapter(deps.cameras),
      },
    },
  },
  wifi: {
    name: 'WLAN-Accesspoints',
    system: 'comms',
    drivers: {
      openwrt: {
        label: 'OpenWrt-Accesspoints aus den Einstellungen',
        description:
          'Fragt die unter „WLAN-Accesspoints“ eingetragenen OpenWrt-Geräte ab: angemeldete Geräte in Betriebs-WLAN und Gastnetz (Netzwerk-Seite) und Erreichbarkeit – ein nicht erreichbarer Accesspoint löst einen Alarm aus.',
        options: {
          pollSeconds: { type: 'int', label: 'Abfrageintervall (Sekunden)', required: false, default: 10, min: 5, max: 300 },
        },
        create: (o, deps) => new OpenWrtWifiAdapter(deps.wifi, Number(o.pollSeconds || 10) * 1000),
      },
    },
  },
  monitoring: {
    name: 'Monitoring',
    system: 'comms',
    drivers: {
      standard: {
        label: 'Ziele aus den Einstellungen',
        description:
          'Fragt die unter „Monitoring“ eingetragenen Geräte ab: Drucker und andere Geräte per SNMP, Rechner per Prometheus Node Exporter. Auffällige Messwerte erscheinen als Meldung; nicht erreichbar löst nur bei dauerhaft eingeschalteten Geräten einen Alarm aus.',
        options: {
          pollSeconds: { type: 'int', label: 'Abfrageintervall (Sekunden)', required: false, default: 30, min: 10, max: 600 },
        },
        create: (o, deps) => new MonitoringAdapter(deps.monitoring, Number(o.pollSeconds || 30) * 1000),
      },
    },
  },
  bluetooth: {
    name: 'Bluetooth',
    system: 'energy',
    drivers: {
      sim: {
        label: 'Simulation',
        description: 'Simuliert Victron-Lithium-Batterien (mit „Shunt“ im Namen einen SmartShunt) für die eingetragenen Geräte und zeigt drei Geräte „in der Nähe“.',
        options: { staleSeconds: { type: 'int', label: 'Kein Empfang nach (Sekunden)', required: false, default: 60, min: 10, max: 3600 } },
        create: (o, deps) => new BluetoothAdapter('sim', deps.bluetooth, new SimScanner(deps.bluetooth), { staleMs: Number(o.staleSeconds || 60) * 1000 }),
      },
      bluez: {
        label: 'Bluetooth-Adapter des Servers (BlueZ)',
        description:
          'Liest über den Bluetooth-Dongle des Servers die Werbepakete der eingetragenen Geräte mit (Victron Instant Readout: Lithium-Batterien, SmartShunt/BMV, MPPT, Orion, Ladegeräte). Nutzt BlueZ (bluetoothd) des Hosts über den D-Bus-System-Bus; nur lesend, ohne Kopplung.',
        options: {
          adapter: { type: 'string', label: 'Bluetooth-Adapter', required: true, default: 'hci0', pattern: '^hci\\d{1,2}$', help: 'Mit „bluetoothctl list“ bzw. „hciconfig“ auf dem Server ermitteln. Meist hci0.' },
          staleSeconds: {
            type: 'int',
            label: 'Kein Empfang nach (Sekunden)',
            required: false,
            default: 60,
            min: 10,
            max: 3600,
            help: 'So lange darf ein Gerät schweigen, bevor ELVIS „kein Empfang“ meldet. Victron sendet etwa jede Sekunde.',
          },
          passive: {
            type: 'bool',
            label: 'Passiv mitlesen',
            required: false,
            default: true,
            help: 'Durchgehend mitlesen statt alle 10 s neu zu suchen (BlueZ Advertisement Monitor). Schont den Dongle – manche Realtek-Dongles hängen sich bei der aktiven Suche nach einer Weile auf. Kann BlueZ das nicht, sucht ELVIS automatisch aktiv.',
          },
        },
        create: (o, deps) =>
          new BluetoothAdapter('bluez', deps.bluetooth, new BluezScanner(String(o.adapter || 'hci0'), undefined, { passive: o.passive !== false }), { staleMs: Number(o.staleSeconds || 60) * 1000 }),
      },
    },
  },
  radio: {
    name: 'Funk',
    system: 'comms',
    drivers: {
      sim: sim(() => new RadioSim()),
      'reichert-zbe': {
        label: 'Reichert ZBE',
        description:
          'Funkgeräte an einer Reichert ZBE (Zentrale Bedieneinheit, bis zu 20 Anschlüsse). ELVIS meldet sich per TCP als Client an und zeigt Sprache mit Sprecher, SDS, Status und Positionsmeldungen je Anschluss in der Timeline des Funkverkehrs. Nur lesend. Zum Testen ohne Anlage: „npm run zbe:sim -w @elvis/server“.',
        options: {
          host: { type: 'string', label: 'Adresse der ZBE', required: true, default: '127.0.0.1', help: 'IP-Adresse oder Hostname des Reichert-Servers im Fahrzeugnetz.' },
          port: { type: 'int', label: 'Port', required: false, default: ZBE_PORT, min: 1, max: 65535 },
          username: { type: 'string', label: 'Benutzer', required: false, default: '', help: 'Leer = Standardzugang der ZBE („api“).' },
          password: { type: 'password', label: 'Passwort', required: false, help: 'Leer = Standardzugang der ZBE.' },
          clientNumber: { type: 'int', label: 'Clientnummer', required: false, default: 1, min: 0, max: 999, help: 'Nummer, unter der sich ELVIS an der ZBE anmeldet („context client“).' },
          radios: {
            type: 'string',
            label: 'Funkgeräte',
            required: false,
            default: '1:MRT:MRT Fahrzeug; 2:FRT:Funkplatz 1; 3:FRT:Funkplatz 2',
            maxLength: 1000,
            pattern: RADIOS_PATTERN,
            help: 'Je Gerät „Anschluss:Typ:Name[:ISSI]“ mit dem Anschluss wie in den Einstellungen der ZBE (1–20), getrennt durch Semikolon; Typ MRT, FRT oder HRT. Meldet die ZBE einen anderen Anschluss, legt ELVIS ihn als „Anschluss <Nummer>“ an.',
          },
          style: {
            type: 'select',
            label: 'Schreibweise der Telegramme',
            required: false,
            default: 'comma',
            choices: [
              { value: 'comma', label: 'Komma-getrennt (Standard)' },
              { value: 'space', label: 'Leerzeichen-getrennt' },
            ],
            help: 'Gilt für die Anmeldung. Nur umstellen, wenn die ZBE nach dem Verbinden keine Ereignisse schickt. Empfangen werden beide Schreibweisen.',
          },
          reconnectSeconds: { type: 'int', label: 'Neuer Verbindungsversuch nach (Sekunden)', required: false, default: 10, min: 2, max: 300 },
        },
        create: (o) =>
          new ReichertZbeAdapter({
            host: String(o.host || '127.0.0.1'),
            port: Number(o.port || ZBE_PORT),
            username: String(o.username ?? ''),
            password: String(o.password ?? ''),
            clientNumber: Number(o.clientNumber ?? 1),
            style: o.style === 'space' ? 'space' : 'comma',
            radios: parseRadios(String(o.radios ?? '')),
            reconnectMs: Number(o.reconnectSeconds || 10) * 1000,
          }),
      },
    },
  },
  telephony: {
    name: 'Telefonie (GSM-Gateway)',
    system: 'comms',
    drivers: {
      sim: {
        label: 'Simulation',
        description: 'Zwei GSM-Trunks mit gelegentlichen Anrufen und SMS. Eine SMS mit „#fehler“ im Text schlägt fehl.',
        options: {},
        create: (_o, deps) => new TelephonySim(deps.telephony),
      },
      'yeastar-tg': {
        label: 'Yeastar NeoGate TG (TG200 u. a.)',
        description:
          'GSM-Gateway über die TG-API (TCP 5038): Zustand der GSM-Trunks, SMS senden und empfangen, Anrufe ins Einsatztagebuch. Die API muss im Gateway freigeschaltet sein (eigener API-Benutzer). Den SIP-Zustand meldet die API nicht – ELVIS prüft, ob der SIP-Dienst des Gateways antwortet.',
        options: {
          host: { type: 'string', label: 'Adresse des Gateways', required: true, default: '192.168.128.150', help: 'IP-Adresse oder Hostname im Fahrzeugnetz.' },
          port: { type: 'int', label: 'API-Port', required: false, default: TG_PORT, min: 1, max: 65535 },
          username: { type: 'string', label: 'API-Benutzer', required: true, default: 'apiuser', help: 'Im Gateway unter „API“ eingerichtet – nicht der Benutzer der Weboberfläche.' },
          password: { type: 'password', label: 'API-Passwort', required: true },
          trunks: {
            type: 'string',
            label: 'Bezeichnung der Trunks',
            required: false,
            default: '1:GSM 1; 2:GSM 2',
            maxLength: 300,
            pattern: TRUNKS_PATTERN,
            help: 'Je Port „Nummer:Name“, getrennt durch Semikolon, z. B. „1:Telekom D1; 2:Vodafone“.',
          },
          smsPort: { type: 'int', label: 'Port für ausgehende SMS', required: false, default: 1, min: 0, max: 32, help: '0 = erster verbundener Trunk.' },
          sipCheck: { type: 'bool', label: 'SIP-Dienst prüfen', required: false, default: true, help: 'Fragt den SIP-Dienst des Gateways per SIP OPTIONS (UDP) ab.' },
          sipPort: { type: 'int', label: 'SIP-Port des Gateways', required: false, default: 5060, min: 1, max: 65535 },
          pollSeconds: { type: 'int', label: 'Abfrageintervall (Sekunden)', required: false, default: 30, min: 5, max: 600 },
          reconnectSeconds: { type: 'int', label: 'Neuer Verbindungsversuch nach (Sekunden)', required: false, default: 10, min: 2, max: 300 },
        },
        create: (o, deps) =>
          new YeastarTgAdapter(
            {
              host: String(o.host || '192.168.128.150'),
              port: Number(o.port || TG_PORT),
              username: String(o.username ?? ''),
              password: String(o.password ?? ''),
              trunks: parseTrunks(String(o.trunks ?? '')),
              smsPort: Number(o.smsPort ?? 1) > 0 ? Number(o.smsPort ?? 1) : null,
              sipPort: o.sipCheck === false ? null : Number(o.sipPort || 5060),
              pollMs: Number(o.pollSeconds || 30) * 1000,
              reconnectMs: Number(o.reconnectSeconds || 10) * 1000,
            },
            deps.telephony,
          ),
      },
    },
  },
  signal: {
    name: 'Signal',
    system: 'comms',
    drivers: {
      sim: { ...messengerSim('Signal'), create: (_o, deps) => new MessengerSim('signal', deps.messenger) },
      'signal-cli': {
        label: 'signal-cli (Addon)',
        description:
          'Signal über signal-cli aus dem Addon „Signal (signal-cli)“ – das Addon zuerst auf einem Docker-Host installieren, ELVIS findet es von selbst. Einrichten unter dem Modul: als verknüpftes Gerät per QR-Code oder mit eigener Nummer (Captcha und Bestätigungscode). Text und Bilder; Standorte gehen als Kartenlink.',
        options: {
          account: { type: 'string', label: 'Rufnummer des Kontos', required: false, default: '', maxLength: 40, help: 'Nur nötig, wenn in signal-cli mehrere Konten liegen; leer = das erste. Eine neue Nummer richtet die Karte „Signal-Konto“ ein.' },
          deviceName: { type: 'string', label: 'Gerätename beim Koppeln', required: false, default: 'ELVIS', maxLength: 50, help: 'So erscheint ELVIS in der Signal-App unter „Verknüpfte Geräte“.' },
          reconnectSeconds: { type: 'int', label: 'Neuer Verbindungsversuch nach (Sekunden)', required: false, default: 15, min: 2, max: 600 },
        },
        create: (o, deps) =>
          new SignalCliAdapter(
            {
              // Immer signal-cli aus dem Addon (Adresse und Token meldet das Addon über provides.messengers)
              endpoint: () => {
                const addon = deps.messengerServices.first('signal-cli');
                return addon ? { url: addon.url, token: addon.token } : null;
              },
              account: String(o.account ?? '').trim() || null,
              deviceName: String(o.deviceName || 'ELVIS'),
              reconnectMs: Number(o.reconnectSeconds || 15) * 1000,
            },
            deps.messenger,
          ),
      },
    },
  },
  threema: {
    name: 'Threema',
    system: 'comms',
    drivers: {
      sim: { ...messengerSim('Threema'), create: (_o, deps) => new MessengerSim('threema', deps.messenger) },
      'gateway-e2e': {
        label: 'Threema Gateway (E2E)',
        description:
          'Threema Gateway im Ende-zu-Ende-Modus (gateway.threema.ch): ELVIS verschlüsselt selbst, der private Schlüssel bleibt im Fahrzeug. Jede Nachricht kostet Credits. Empfang über das Cloud-Relay – die Rückruf-URL steht unter dem Modul und wird bei der Gateway-ID eingetragen. Text, Bilder und Standorte.',
        options: {
          gatewayId: { type: 'string', label: 'Gateway-ID', required: true, maxLength: 8, pattern: '^\\*[A-Z0-9]{7}$', help: 'E2E-ID mit Stern, z. B. *ELVIS01' },
          secret: { type: 'password', label: 'API-Secret', required: true },
          privateKey: { type: 'password', label: 'Privater Schlüssel', required: true, help: '64 Hex-Zeichen (auch „private:…“), beim Anlegen der ID mit dem Threema-Werkzeug erzeugt.' },
          apiUrl: { type: 'string', label: 'API-Adresse', required: false, default: 'https://msgapi.threema.ch', maxLength: 200 },
        },
        create: (o, deps) =>
          new ThreemaGatewayAdapter(
            { gatewayId: String(o.gatewayId ?? '').trim().toUpperCase(), secret: String(o.secret ?? ''), privateKey: String(o.privateKey ?? ''), apiUrl: String(o.apiUrl || 'https://msgapi.threema.ch') },
            deps.messenger,
            deps.hooks,
          ),
      },
    },
  },
  whatsapp: {
    name: 'WhatsApp',
    system: 'comms',
    drivers: {
      sim: { ...messengerSim('WhatsApp'), create: (_o, deps) => new MessengerSim('whatsapp', deps.messenger) },
      'cloud-api': {
        label: 'WhatsApp Cloud API (Meta)',
        description:
          'Offizielle Cloud API von Meta mit eigener Rufnummer (WhatsApp Business). Senden über die Graph API, Empfang über das Cloud-Relay – Webhook-Adresse und Prüf-Token stehen unter dem Modul. Freie Nachrichten gehen nur bis 24 h nach der letzten Nachricht der Gegenstelle, danach nur eine freigegebene Vorlage. Ob eine Rufnummer WhatsApp nutzt, verrät die Cloud API nicht.',
        options: {
          phoneNumberId: { type: 'string', label: 'Phone-Number-ID', required: true, maxLength: 40, pattern: '^\\d{5,30}$', help: 'Meta-Entwicklerportal → WhatsApp → API-Setup' },
          accessToken: { type: 'password', label: 'Zugriffstoken', required: true, help: 'Dauerhaftes Token eines Systembenutzers (Business-Einstellungen), nicht das 24-h-Testtoken.' },
          appSecret: { type: 'password', label: 'App-Geheimnis', required: true, help: 'App-Einstellungen → Allgemein; prüft die Signatur eingehender Webhooks.' },
          templateName: { type: 'string', label: 'Vorlage außerhalb des 24-h-Fensters', required: false, default: '', maxLength: 100, help: 'Name einer freigegebenen Vorlage; leer = außerhalb des Fensters nicht senden.' },
          templateLanguage: { type: 'string', label: 'Sprache der Vorlage', required: false, default: 'de', maxLength: 10 },
          templateHasText: { type: 'bool', label: 'Vorlage hat einen Textbaustein {{1}}', required: false, default: true, help: 'Der Nachrichtentext kommt in den Baustein {{1}} der Vorlage.' },
          graphUrl: { type: 'string', label: 'Graph-API', required: false, default: 'https://graph.facebook.com/v21.0', maxLength: 200 },
        },
        create: (o, deps) =>
          new WhatsAppCloudAdapter(
            {
              phoneNumberId: String(o.phoneNumberId ?? '').trim(),
              accessToken: String(o.accessToken ?? ''),
              appSecret: String(o.appSecret ?? ''),
              templateName: String(o.templateName ?? '').trim(),
              templateLanguage: String(o.templateLanguage || 'de'),
              templateHasText: o.templateHasText !== false,
              graphUrl: String(o.graphUrl || 'https://graph.facebook.com/v21.0'),
            },
            deps.messenger,
            deps.hooks,
          ),
      },
    },
  },
  telegram: {
    name: 'Telegram',
    system: 'comms',
    drivers: {
      sim: { ...messengerSim('Telegram'), create: (_o, deps) => new MessengerSim('telegram', deps.messenger) },
      mtproto: {
        label: 'Telegram-Konto (MTProto)',
        description:
          'Eigenes Telegram-Konto des Fahrzeugs (kein Bot): kann Rufnummern anschreiben und prüfen, wer Telegram nutzt (über den Kontaktimport des Kontos). API-ID und API-Hash unter my.telegram.org → „API development tools“ anlegen. Anmelden unter dem Modul mit Code und ggf. Passwort; die Sitzung bleibt gespeichert.',
        options: {
          apiId: { type: 'int', label: 'API-ID', required: true, min: 1, max: 2147483647, help: 'my.telegram.org → API development tools' },
          apiHash: { type: 'password', label: 'API-Hash', required: true },
          phone: { type: 'string', label: 'Rufnummer des Kontos', required: true, maxLength: 40, pattern: '^\\+?[\\d\\s/()-]{6,30}$', help: 'Mit Ländervorwahl, z. B. +49 170 1234567.' },
        },
        create: (o, deps) =>
          new TelegramAdapter({ apiId: Number(o.apiId ?? 0), apiHash: String(o.apiHash ?? ''), phone: phoneKey(String(o.phone ?? '')) }, deps.messenger, deps.vault),
      },
    },
  },
  network: { name: 'Netzwerk & Datenfunk', system: 'comms', drivers: { sim: sim(() => new NetworkSim()) } },
  media: { name: 'Videomatrix & Kameras', system: 'media', drivers: { sim: sim(() => new MediaSim()) } },
  weather: {
    name: 'Wetterstation',
    system: 'media',
    drivers: {
      sim: sim(() => new WeatherSim()),
      'actisense-airmar': {
        label: 'Airmar über Actisense NGT-1/NGX-1 (NMEA 2000)',
        description:
          'Airmar-WeatherStation (z. B. 150WX/200WX) am NMEA-2000-Bus, per USB über ein Actisense-Gateway angeschlossen. Liefert Wind, Temperatur, Luftdruck, ggf. Luftfeuchte, GPS-Position und Kurs.',
        options: {
          port: { type: 'serialport', label: 'Serielle Schnittstelle', required: true, help: 'USB-Anschluss des Actisense-Gateways (meldet sich als FTDI-Gerät).' },
          baudRate: {
            type: 'select',
            label: 'Baudrate',
            required: false,
            default: '115200',
            choices: [
              { value: '115200', label: '115200 (Standard)' },
              { value: '230400', label: '230400' },
            ],
          },
          sourceAddress: {
            type: 'string',
            label: 'NMEA-2000-Adresse der Station',
            required: false,
            default: '',
            pattern: '^(|\\d{1,3})$',
            help: 'Leer = alle Quellen. Nur nötig, wenn mehrere Wettersensoren am Bus hängen.',
          },
          setRxAll: {
            type: 'bool',
            label: 'Gateway auf „Rx All“ stellen',
            required: false,
            default: true,
            help: 'Damit das Gateway alle Nachrichten weiterleitet. Nur abschalten, wenn es im Actisense Toolkit fest konfiguriert ist.',
          },
        },
        create: (o) =>
          new AirmarAdapter({
            port: o.port,
            baudRate: Number(o.baudRate ?? 115200),
            sourceAddress: o.sourceAddress === undefined || o.sourceAddress === '' ? null : Number(o.sourceAddress),
            setRxAll: o.setRxAll ?? true,
          }),
      },
    },
  },
};
