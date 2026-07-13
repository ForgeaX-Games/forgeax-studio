// Asset-fetch routing/concurrency gate (perf "A" with "C" fallback).
//
// WHY
//   Studio is single-origin: the in-process engine viewport streams a game's
//   assets (meshes/textures) from the SAME origin as the shell's own REST API.
//   A heavy game (e.g. hellforge — dozens of 9–14MB .glb) opens enough parallel
//   asset requests to exhaust the browser's HTTP/1.1 per-origin connection cap
//   (~6), so the shell's poll/stream calls (/api/workbench/*, /api/chat, …) sit
//   "pending" behind them and every panel looks frozen/blank.
//
// TWO STRATEGIES, ONE GATE
//   • "A" (root fix, dev): when a dedicated asset origin is configured
//     (__FORGEAX_ASSET_ORIGIN__ — the play-engine vite :15173 in dev), rewrite
//     same-origin asset requests to THAT origin. A separate origin has its own
//     browser connection pool, so asset traffic can never starve the shell API
//     on the page origin. No cap needed — the pool is independent.
//   • "C" (fallback, packaged/no asset origin): cap how many game-asset requests
//     may be in flight at once so there's always connection headroom for the
//     shell API on the shared origin. Because the fetch promise resolves at
//     response HEADERS (not body end), we fully buffer gated bodies so a slot is
//     held for the whole transfer — otherwise a big .glb body still on the wire
//     wouldn't count against the cap. Assets are read in full anyway, so
//     buffering costs nothing beyond dropping streaming (irrelevant one-shot).
//
// Touches ONLY game-asset URLs; shell API / WS / chrome traffic is untouched.

/** The dedicated asset origin, or '' for same-origin (define-injected). Guarded
 *  with typeof so importing this outside the studio bundle can't ReferenceError. */
const ASSET_ORIGIN: string =
  typeof __FORGEAX_ASSET_ORIGIN__ === 'string' ? __FORGEAX_ASSET_ORIGIN__ : '';

/** Max concurrent game-asset requests on the SHARED origin (fallback path).
 *  Browsers allow ~6 HTTP/1.1 connections per origin; capping assets at 4 always
 *  leaves ≥2 for the shell API/streams. Unused when ASSET_ORIGIN is set. */
const MAX_ASSET_CONCURRENCY = 4;

/** URL looks like game-asset traffic (heavy binary formats + the engine's asset
 *  transport routes) rather than shell API / chrome assets. Kept deliberately
 *  narrow so UI icons and API calls are never gated/rerouted. */
function isAssetUrl(url: string): boolean {
  // Strip query/hash before the extension test so `foo.glb?x=1` still matches.
  const path = url.split('?')[0]!.split('#')[0]!;
  if (
    path.includes('/__import') ||
    path.includes('/__forgeax-ddc') ||
    path.includes('/preview/') ||
    path.includes('/api/game-assets') ||
    path.includes('/api/gen3d') ||
    path.includes('pack-index')
  ) {
    return true;
  }
  return /\.(glb|gltf|bin|ktx2|hdr|pack\.json)$/i.test(path);
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return (input as Request).url;
}

/** Rewrite a same-origin (or root-relative) asset URL onto the dedicated asset
 *  origin. Leaves already-cross-origin URLs and Request objects untouched
 *  (returns null → caller keeps the original input). */
function reroute(url: string): string | null {
  if (!ASSET_ORIGIN) return null;
  // The dev asset origin is a loopback port (:15173) reachable only when the
  // shell is itself served on loopback. If the page is opened through a remote
  // dev gateway, that port isn't reachable from the browser — don't reroute
  // (fall back to the same-origin proxy + concurrency cap instead of 404ing).
  const host = window.location.hostname;
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]' && host !== '::1') {
    return null;
  }
  try {
    const u = new URL(url, window.location.origin);
    if (u.origin !== window.location.origin) return null; // already elsewhere
    return ASSET_ORIGIN.replace(/\/+$/, '') + u.pathname + u.search + u.hash;
  } catch {
    return null;
  }
}

// ── tiny FIFO semaphore (fallback path only) ──────────────────────────────────
let active = 0;
const waiters: Array<() => void> = [];

function acquire(): Promise<void> {
  if (active < MAX_ASSET_CONCURRENCY) {
    active += 1;
    return Promise.resolve();
  }
  // A released slot is handed directly to the next waiter (active stays put), so
  // we do NOT increment here — the grant is accounted by the holder we inherit.
  return new Promise<void>((res) => waiters.push(res));
}

function release(): void {
  const next = waiters.shift();
  if (next) next();
  else active -= 1;
}

let installed = false;

/** Monkeypatch window.fetch once so game-asset requests are rerouted to the
 *  dedicated asset origin ("A") or concurrency-capped on the shared origin
 *  ("C"). Idempotent (StrictMode double-invoke safe). Must run before the engine
 *  viewport boots so the very first asset burst is handled. */
export function installAssetFetchGate(): void {
  if (installed) return;
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  installed = true;

  const orig = window.fetch.bind(window);

  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let url: string;
    try { url = urlOf(input); } catch { return orig(input as RequestInfo, init); }
    if (!isAssetUrl(url)) return orig(input as RequestInfo, init);

    // "A": a dedicated asset origin is configured — reroute string/URL inputs
    // there (own connection pool) and let the browser parallelize freely. No cap
    // and no body buffering: the separate origin is what prevents starvation.
    if (ASSET_ORIGIN && (typeof input === 'string' || input instanceof URL)) {
      const rerouted = reroute(url);
      if (rerouted) return orig(rerouted, init);
    }

    // "C": shared-origin fallback — gate concurrency and hold the slot until the
    // body is fully down the wire, then hand back an already-read Response the
    // loader consumes normally (.arrayBuffer()/.json()/.blob()).
    await acquire();
    try {
      const res = await orig(input as RequestInfo, init);
      // Null-body statuses (204/205/304 …) can't be reconstructed via
      // `new Response(buf, { status })` — and carry no bytes — so return as-is.
      if (res.status === 101 || res.status === 204 || res.status === 205 || res.status === 304 || res.body === null) {
        return res;
      }
      const buf = await res.arrayBuffer();
      return new Response(buf, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
    } finally {
      release();
    }
  }) as typeof fetch;
}
