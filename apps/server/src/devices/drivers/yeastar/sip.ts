import { randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';

/**
 * Prüft per SIP OPTIONS (UDP), ob der SIP-Dienst eines Geräts antwortet. Jede SIP-Antwort zählt – auch
 * „401 Unauthorized“ oder „404“, denn dann läuft der Dienst. Liefert die Statuszeile oder null bei Zeitüberschreitung.
 */
export function sipOptions(host: string, port = 5060, timeoutMs = 2000): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = createSocket('udp4');
    const branch = `z9hG4bK${randomBytes(6).toString('hex')}`;
    const tag = randomBytes(4).toString('hex');
    const callId = `${randomBytes(8).toString('hex')}@elvis`;
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* schon zu */
      }
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.on('error', () => finish(null));
    socket.on('message', (msg) => {
      const first = msg.toString('utf8').split(/\r?\n/, 1)[0] ?? '';
      if (/^SIP\/2\.0 \d{3}/.test(first) && msg.toString('utf8').includes(callId)) finish(first.trim());
    });
    socket.bind(0, () => {
      const local = socket.address().port;
      const req = [
        `OPTIONS sip:${host}:${port} SIP/2.0`,
        `Via: SIP/2.0/UDP 0.0.0.0:${local};branch=${branch};rport`,
        'Max-Forwards: 70',
        `From: <sip:elvis@elvis.invalid>;tag=${tag}`,
        `To: <sip:${host}:${port}>`,
        `Call-ID: ${callId}`,
        'CSeq: 1 OPTIONS',
        'User-Agent: ELVIS',
        'Accept: application/sdp',
        'Content-Length: 0',
        '',
        '',
      ].join('\r\n');
      socket.send(req, port, host, (err) => err && finish(null));
    });
  });
}
