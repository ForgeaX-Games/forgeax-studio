/**
 * Plugin-side diagnostics bridge — forwards a plugin iframe's console errors +
 * uncaught exceptions to the host shell so they land in the studio health feed
 * instead of dying in the plugin iframe's own DevTools.
 *
 * Why here: plugin panels are cross-origin/cross-document iframes; the shell
 * can't read their console. The shell's healthBridge already CONSUMES a
 * `forgeax:health` envelope (and tags `source:'plugin'`), but plugins never
 * EMITTED one — so plugin failures were invisible. Installing this once from
 * `createHost` (the universal plugin-side entry) covers every SDK plugin with
 * zero per-plugin code.
 *
 * It posts the raw envelope shape directly (no schema import) — the shell
 * validates inbound on its side. `source:'plugin'` is self-declared; the shell
 * trusts it. Only error/warn are forwarded (the health feed's levels); normal
 * logs stay local to keep the wire quiet.
 */

let installed = false;

function fmt(args: unknown[]): string {
  return args
    .map((a) => (a instanceof Error ? (a.stack?.split('\n')[0] ?? a.message)
      : typeof a === 'string' ? a
      : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()))
    .join(' ');
}

/**
 * Install console-error/warn + window error/rejection forwarding to the host.
 * Idempotent and a no-op outside an iframe (no parent) or without a DOM.
 */
export function installExtensionDiagnosticsBridge(extensionId?: string): void {
  if (installed) return;
  if (typeof window === 'undefined' || window.parent === window) return; // not in an iframe
  installed = true;

  const send = (level: 'error' | 'warn', code: string, message: string): void => {
    try {
      window.parent.postMessage(
        { type: 'forgeax:health', level, source: 'plugin', code, message: extensionId ? `[${extensionId}] ${message}` : message, ts: Date.now() },
        '*',
      );
    } catch { /* dead parent — drop */ }
  };

  for (const level of ['error', 'warn'] as const) {
    const orig = (console[level] as (...a: unknown[]) => void).bind(console);
    console[level] = (...args: unknown[]): void => {
      orig(...args);
      try {
        const text = fmt(args);
        if (text.startsWith('[health]')) return; // avoid loops
        send(level, `console-${level}`, text);
      } catch { /* never throw from logging */ }
    };
  }

  window.addEventListener('error', (ev) => {
    send('error', 'window-error', `${ev.message}${ev.filename ? ` @ ${ev.filename}:${ev.lineno}` : ''}`);
  });
  window.addEventListener('unhandledrejection', (ev) => {
    const reason = (ev as PromiseRejectionEvent).reason;
    const msg = reason instanceof Error ? (reason.stack?.split('\n')[0] ?? reason.message) : String(reason);
    send('error', 'unhandled-rejection', `unhandled rejection: ${msg}`);
  });
}
