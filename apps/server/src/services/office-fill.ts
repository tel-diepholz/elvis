import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { extensionOf, placeholderValue, type PlaceholderBags } from '@elvis/shared';

/** Teile der Office-Formate, in denen sichtbarer Text steht */
const TEXT_PARTS: Record<string, RegExp> = {
  docx: /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/,
  xlsx: /^xl\/(sharedStrings|worksheets\/sheet\d+)\.xml$/,
  pptx: /^ppt\/(slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/,
  odt: /^(content|styles)\.xml$/,
  ods: /^(content|styles)\.xml$/,
  odp: /^(content|styles)\.xml$/,
};

export const fillableExtension = (filename: string) => extensionOf(filename) in TEXT_PARTS;

const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Word & Co. teilen Text oft in mehrere Läufe (<w:r>) auf, z. B. „{{einsatz.“ und „stichwort}}“. Deshalb sind zwischen
 * allen Zeichen eines Platzhalters XML-Tags erlaubt. Der Treffer wird durch den Wert ersetzt; die Tags dazwischen
 * entfallen, die öffnenden/schließenden Tags am Rand bleiben stehen, damit das XML gültig bleibt.
 */
const TAG = '(?:<[^>]*>)*';
const PLACEHOLDER = new RegExp(`\\{${TAG}\\{((?:${TAG}[\\sa-zA-Z0-9_.])+?)${TAG}\\}${TAG}\\}`, 'g');

export function fillXml(xml: string, bags: PlaceholderBags): string {
  return xml.replace(PLACEHOLDER, (match, inner: string) => {
    const name = inner.replace(/<[^>]*>/g, '').trim();
    const m = /^([a-zA-Z]+)\.([a-zA-Z0-9_]+)$/.exec(name);
    const value = m ? placeholderValue(bags, m[1]!, m[2]!) : undefined;
    // Unbekanntes bleibt stehen, damit der Bearbeiter es sieht
    if (value === undefined) return match;
    const tags = match.match(/<[^>]*>/g) ?? [];
    // Tags zwischen den Zeichen gehören paarweise zusammen (Lauf schließen/öffnen). Nur so viele behalten, dass die
    // Struktur stimmt: schließende Tags gehören vor den Wert nicht – wir hängen alle Tags hinter den Wert, die
    // Reihenfolge bleibt erhalten und jedes geöffnete Element wird wieder geschlossen.
    return escapeXml(value) + tags.join('');
  });
}

/** Platzhalter im Inhalt ersetzen; andere Formate und kaputte Dateien bleiben unverändert. */
export function fillDocument(data: Uint8Array, filename: string, bags: PlaceholderBags): Uint8Array {
  const parts = TEXT_PARTS[extensionOf(filename)];
  if (!parts) return data;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data);
  } catch {
    return data;
  }
  const out: Zippable = {};
  for (const [name, content] of Object.entries(files)) {
    // ODF verlangt „mimetype“ als ersten, unkomprimierten Eintrag
    if (name === 'mimetype') out[name] = [content, { level: 0 }];
    else out[name] = parts.test(name) ? strToU8(fillXml(strFromU8(content), bags)) : content;
  }
  return zipSync(out);
}
