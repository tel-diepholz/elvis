/**
 * Zugriff auf den Speicher der LOGO (Datenbaustein 1, „VM-Adressen“). Der echte Client spricht S7 über nodes7;
 * Tests und die Simulation setzen eine Nachbildung ein.
 */
export interface LogoClient {
  connect(): Promise<void>;
  /** length Byte ab Byteadresse offset in DB1 */
  readBytes(ranges: { offset: number; length: number }[]): Promise<Uint8Array[]>;
  writeBit(byte: number, bit: number, value: boolean): Promise<void>;
  close(): Promise<void>;
}

export interface LogoConnection {
  host: string;
  port: number;
  /** TSAP des Clients (ELVIS) und des Servers (LOGO), z. B. 0x0100 und 0x0200 – in LOGO Soft Comfort einstellbar */
  localTsap: number;
  remoteTsap: number;
  timeoutMs: number;
}

export type LogoClientFactory = (c: LogoConnection) => LogoClient;
