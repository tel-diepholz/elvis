/**
 * Version dieser ELVIS-Installation. Das Windows-Bündel (apps/windows) setzt sie beim Bauen fest ein (aus dem
 * Release-Tag); sonst aus der Umgebung, ohne Angabe „dev“.
 */
export const ELVIS_VERSION: string = process.env.ELVIS_VERSION || 'dev';
