// Nur die Teile von svg-to-pdfkit, die der Kartendruck nutzt (das Paket bringt keine Typen mit)
declare module 'svg-to-pdfkit' {
  interface Options {
    width?: number;
    height?: number;
    preserveAspectRatio?: string;
    /** Liefert den Namen einer bei PDFKit registrierten Schrift für eine Schriftfamilie im SVG */
    fontCallback?: (family: string, bold: boolean, italic: boolean) => string;
    warningCallback?: (message: string) => void;
  }
  export default function SVGtoPDF(doc: PDFKit.PDFDocument, svg: string, x: number, y: number, options?: Options): void;
}
