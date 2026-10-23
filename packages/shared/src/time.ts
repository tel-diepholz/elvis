const DTG_MONTHS = ['jan', 'feb', 'mär', 'apr', 'mai', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dez'];

/** Datum-Zeit-Gruppe (TTHHMM + Monat + JJ), wie im BOS-Funk üblich, z. B. 220847okt26. */
export function formatDtg(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${DTG_MONTHS[d.getMonth()]}${String(d.getFullYear()).slice(2)}`;
}
