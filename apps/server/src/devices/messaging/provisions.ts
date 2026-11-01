/** Hilfsdienst eines Messengers aus einem laufenden Addon (provides.messengers, Platzhalter bereits ersetzt) */
export interface MessengerProvision {
  id: string;
  name: string;
  kind: 'signal-cli';
  url: string;
  token: string | null;
}

/**
 * Messenger-Hilfsdienste laufender Addons (z. B. signal-cli). Die Treiber fragen bei jedem Verbindungsversuch nach –
 * so greift ein später gestartetes oder neu installiertes Addon ohne Neustart des Moduls.
 */
export class MessengerProvisions {
  private list: MessengerProvision[] = [];

  setProvisions(list: MessengerProvision[]): void {
    this.list = list;
  }

  first(kind: MessengerProvision['kind']): MessengerProvision | null {
    return this.list.find((p) => p.kind === kind) ?? null;
  }
}
