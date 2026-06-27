// Flip to true when debugging pipeline issues
const DEBUG = true;

export function debugLog(...args: any[]): void {
  if (DEBUG) console.error(...args);
}
