import { CHAT_CHANNEL_LABEL, type ChatChannel } from '@elvis/shared';

/** Markenfarbe je Kanal (SMS neutral) */
const COLOR: Record<ChatChannel, string> = {
  sms: '#6b7280',
  signal: '#3a76f0',
  threema: '#262a2e',
  whatsapp: '#25d366',
  telegram: '#229ed9',
  elvis: '#c8102e',
};

/** Weißes Zeichen im Kreis, vereinfacht (keine Original-Logos) */
const GLYPH: Record<ChatChannel, JSX.Element> = {
  // Sprechblase
  sms: <path d="M7 8.5h10a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-6l-3 2.5v-2.5H7a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1z" fill="#fff" />,
  // gestrichelter Ring mit Sprechblasenspitze
  signal: (
    <g fill="none" stroke="#fff" strokeWidth="1.6">
      <circle cx="12" cy="12" r="5.2" strokeDasharray="2.2 1.4" />
      <path d="M8.2 16.4 7.2 18.3l2.3-.6" strokeLinejoin="round" />
    </g>
  ),
  // Schloss mit drei Punkten
  threema: (
    <g fill="#3fe669">
      <rect x="8.5" y="10.5" width="7" height="5" rx="1" />
      <path d="M10 10.5V9.3a2 2 0 0 1 4 0v1.2" fill="none" stroke="#3fe669" strokeWidth="1.4" />
      <circle cx="9.3" cy="17.8" r=".9" />
      <circle cx="12" cy="17.8" r=".9" />
      <circle cx="14.7" cy="17.8" r=".9" />
    </g>
  ),
  // Hörer in der Sprechblase
  whatsapp: (
    <g>
      <path d="M12 6.3a5.7 5.7 0 0 0-4.9 8.6l-.8 2.8 2.9-.8A5.7 5.7 0 1 0 12 6.3z" fill="none" stroke="#fff" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M10.1 9.6c.2-.3.6-.3.8 0l.5 1c.1.2 0 .4-.1.6l-.3.3c.4.8 1 1.4 1.8 1.8l.3-.3c.2-.1.4-.2.6-.1l1 .5c.3.2.3.6 0 .8-.6.6-1.4.8-2.2.4a6 6 0 0 1-2.8-2.8c-.3-.8-.2-1.6.4-2.2z" fill="#fff" />
    </g>
  ),
  // Einsatzfahrzeug von der Seite
  elvis: (
    <g fill="#fff">
      <path d="M5.5 9.5h8.2v5.6H5.5zM13.7 11h2.8l2 2.2v1.9h-4.8z" />
      <rect x="8" y="8" width="3" height="1.2" rx=".4" />
      <circle cx="8.2" cy="16" r="1.3" stroke="#c8102e" strokeWidth=".8" />
      <circle cx="16" cy="16" r="1.3" stroke="#c8102e" strokeWidth=".8" />
    </g>
  ),
  // Papierflieger
  telegram: <path d="m6.5 11.6 10.4-4c.5-.2.9.1.8.7l-1.8 8.4c-.1.5-.5.7-1 .4l-2.7-2-1.3 1.3c-.2.2-.4.2-.5 0l.2-2.7 4.9-4.4c.2-.2 0-.3-.3-.2l-6 3.8-2.6-.8c-.6-.2-.6-.5-.1-.5z" fill="#fff" />,
};

/** Kleines Symbol, über welchen Kanal eine Nachricht kam bzw. ging */
export function ChannelIcon({ channel, size = 16, title }: { channel: ChatChannel; size?: number; title?: string }) {
  const label = title ?? CHAT_CHANNEL_LABEL[channel];
  return (
    <svg className="channel-icon" width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={label}>
      <title>{label}</title>
      <circle cx="12" cy="12" r={channel === 'threema' ? 11.25 : 12} fill={COLOR[channel]} {...(channel === 'threema' && { stroke: '#3fe669', strokeWidth: 1.5 })} />
      {GLYPH[channel]}
    </svg>
  );
}
