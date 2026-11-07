declare module 'nodes7' {
  /** Minimale Typen für die Teile von nodes7, die ELVIS nutzt (die Bibliothek bringt keine mit). */
  class NodeS7 {
    initiateConnection(
      params: { port?: number; host?: string; localTSAP?: number; remoteTSAP?: number; rack?: number; slot?: number; timeout?: number; doNotOptimize?: boolean; debug?: boolean },
      callback: (err?: unknown) => void,
    ): void;
    dropConnection(callback?: () => void): void;
    setTranslationCB(cb: (tag: string) => string | undefined): void;
    addItems(tags: string | string[]): void;
    removeItems(tags?: string | string[]): void;
    readAllItems(callback: (anythingBad: boolean, values: Record<string, unknown>) => void): void;
    writeItems(tags: string | string[], values: unknown, callback: (anythingBad: boolean) => void): void;
  }
  export default NodeS7;
}
