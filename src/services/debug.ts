// Flip to true when debugging pipeline issues
const DEBUG = false;

export function debugLog(...args: any[]): void {
  if (DEBUG) console.log(...args);
}
