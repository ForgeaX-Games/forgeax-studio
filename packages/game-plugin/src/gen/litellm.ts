/**
 * Zero-dependency client for the ForgeaX LiteLLM gateway.
 *
 * The gateway is OpenAI-compatible for images (`/v1/images/generations`,
 * `/v1/images/edits`) and exposes an async task API for 3D
 * (`/v1/3d/generations` -> poll `/v1/3d/tasks/{id}`). We hit it with the built-in
 * `fetch` only — the plugin ships no runtime dependencies, and these two shapes are
 * stable enough not to warrant an SDK.
 *
 * Everything here returns bytes or plain data. Signed asset URLs from the gateway
 * expire (~24h) and must be downloaded server-side; we never hand them back to the AI
 * as if they were durable links.
 */

import type { LiteLlmConfig } from './config';

/**
 * Total budget for a 3D task from submit to completion. Text-to-3D lands in ~90s, but
 * image-to-3D (mesh + texture from a photo) routinely needs several minutes, so the
 * budget is generous. Hosts with a shorter MCP request timeout may cut this off — that
 * is a client limit, not ours.
 */
const TASK_TIMEOUT_MS = 420_000;
/** Gap between task-status polls. Tripo reports progress every few seconds. */
const POLL_INTERVAL_MS = 3_000;
/** Per-request network timeout, so a stalled socket can't hang the whole tool call. */
const REQUEST_TIMEOUT_MS = 60_000;

export interface GeneratedImage {
  readonly bytes: Uint8Array;
  /** 'png' | 'jpg' — inferred from the returned content, defaulting to png. */
  readonly ext: string;
}

export interface Generated3d {
  readonly bytes: Uint8Array;
  /** Model container format, e.g. 'glb'. */
  readonly ext: string;
  /** The type the gateway labelled this asset with (e.g. 'mesh'). */
  readonly assetType: string;
}

function authHeaders(cfg: LiteLlmConfig): Record<string, string> {
  return { authorization: `Bearer ${cfg.apiKey}` };
}

/** Fetch with a hard timeout; surfaces gateway error bodies rather than a bare status. */
async function request(url: string, init: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`LiteLLM ${init.method ?? 'GET'} ${url} failed: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 600)}` : ''}`);
    }
    return res;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`LiteLLM request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function decodeImagePayload(item: { b64_json?: unknown; url?: unknown } | undefined): { b64?: string; url?: string } {
  if (!item) return {};
  const b64 = typeof item.b64_json === 'string' ? item.b64_json : undefined;
  const url = typeof item.url === 'string' ? item.url : undefined;
  return { b64, url };
}

function sniffImageExt(bytes: Uint8Array): string {
  // JPEG starts FF D8 FF; everything else we treat as PNG (what Gemini returns).
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  return 'png';
}

async function materializeImage(payload: { b64?: string; url?: string }): Promise<GeneratedImage> {
  if (payload.b64) {
    const bytes = new Uint8Array(Buffer.from(payload.b64, 'base64'));
    return { bytes, ext: sniffImageExt(bytes) };
  }
  if (payload.url) {
    const res = await request(payload.url, { method: 'GET' });
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { bytes, ext: sniffImageExt(bytes) };
  }
  throw new Error('LiteLLM image response contained neither b64_json nor url.');
}

/** Text-to-image via the OpenAI-compatible generations endpoint. */
export async function generateImage(cfg: LiteLlmConfig, opts: { model: string; prompt: string; size?: string }): Promise<GeneratedImage> {
  const res = await request(`${cfg.baseUrl}/v1/images/generations`, {
    method: 'POST',
    headers: { ...authHeaders(cfg), 'content-type': 'application/json' },
    body: JSON.stringify({ model: opts.model, prompt: opts.prompt, n: 1, ...(opts.size ? { size: opts.size } : {}) }),
  });
  const json = (await res.json()) as { data?: Array<{ b64_json?: unknown; url?: unknown }> };
  return materializeImage(decodeImagePayload(json.data?.[0]));
}

/**
 * Image-to-image via the OpenAI-compatible edits endpoint. Takes a local image's bytes
 * and sends them as multipart — the edits endpoint accepts uploaded files directly,
 * unlike the 3D endpoint which rejects inline images.
 */
export async function editImage(cfg: LiteLlmConfig, opts: { model: string; prompt: string; image: Uint8Array; filename: string }): Promise<GeneratedImage> {
  const form = new FormData();
  form.set('model', opts.model);
  form.set('prompt', opts.prompt);
  form.set('n', '1');
  form.set('image', new Blob([opts.image]), opts.filename);
  const res = await request(`${cfg.baseUrl}/v1/images/edits`, {
    method: 'POST',
    headers: authHeaders(cfg),
    body: form,
  });
  const json = (await res.json()) as { data?: Array<{ b64_json?: unknown; url?: unknown }> };
  return materializeImage(decodeImagePayload(json.data?.[0]));
}

interface TaskState {
  id: string;
  status: string;
  progress?: number;
  data?: Array<{ url?: unknown; type?: unknown; format?: unknown }>;
  error?: unknown;
}

async function submit3dTask(cfg: LiteLlmConfig, body: Record<string, unknown>): Promise<string> {
  const res = await request(`${cfg.baseUrl}/v1/3d/generations`, {
    method: 'POST',
    headers: { ...authHeaders(cfg), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as TaskState;
  if (!json.id) throw new Error(`LiteLLM 3D submit returned no task id: ${JSON.stringify(json).slice(0, 400)}`);
  return json.id;
}

/**
 * Poll a 3D task to completion. Reports progress through `onProgress` so the tool can
 * surface a heartbeat instead of appearing hung for the ~90s a generation takes.
 */
async function poll3dTask(cfg: LiteLlmConfig, id: string, onProgress?: (pct: number) => void): Promise<TaskState> {
  const deadline = Date.now() + TASK_TIMEOUT_MS;
  for (;;) {
    const res = await request(`${cfg.baseUrl}/v1/3d/tasks/${encodeURIComponent(id)}`, {
      method: 'GET',
      headers: authHeaders(cfg),
    });
    const state = (await res.json()) as TaskState;
    if (typeof state.progress === 'number') onProgress?.(state.progress);
    const status = state.status?.toLowerCase();
    if (status === 'succeeded' || status === 'success' || status === 'completed') return state;
    if (status === 'failed' || status === 'error' || status === 'cancelled') {
      throw new Error(`LiteLLM 3D task ${id} ${state.status}${state.error ? `: ${JSON.stringify(state.error).slice(0, 300)}` : ''}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`LiteLLM 3D task ${id} did not finish within ${TASK_TIMEOUT_MS / 1000}s (last status: ${state.status}).`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

/** Pick the downloadable mesh from a finished task's assets and fetch its bytes. */
async function downloadMesh(state: TaskState): Promise<Generated3d> {
  const assets = (state.data ?? []).map((d) => ({
    url: typeof d.url === 'string' ? d.url : undefined,
    type: typeof d.type === 'string' ? d.type : '',
    format: typeof d.format === 'string' ? d.format : '',
  }));
  const mesh = assets.find((a) => a.url && (a.type === 'mesh' || /\.(glb|gltf|obj|fbx|usdz)/i.test(a.url ?? ''))) ?? assets.find((a) => a.url);
  if (!mesh?.url) throw new Error(`LiteLLM 3D task ${state.id} completed with no downloadable mesh asset.`);
  const res = await request(mesh.url, { method: 'GET' });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const ext = mesh.format || (mesh.url.match(/\.([a-z0-9]+)(?:\?|$)/i)?.[1] ?? 'glb').toLowerCase();
  return { bytes, ext, assetType: mesh.type || 'mesh' };
}

/** Text-to-3D: submit a prompt, poll to completion, download the mesh. */
export async function generate3dFromText(cfg: LiteLlmConfig, opts: { model: string; prompt: string; onProgress?: (pct: number) => void }): Promise<Generated3d> {
  const id = await submit3dTask(cfg, { model: opts.model, prompt: opts.prompt });
  return downloadMesh(await poll3dTask(cfg, id, opts.onProgress));
}

/**
 * Image-to-3D from a PUBLIC image URL. The gateway rejects inline base64/data URLs for
 * the 3D endpoint (it wants a Tripo file_token from an upload path this proxy does not
 * expose), so the only reliable input is a URL it can fetch itself. Local files must be
 * hosted first — the tool layer enforces and explains this.
 */
export async function generate3dFromImageUrl(cfg: LiteLlmConfig, opts: { model: string; imageUrl: string; prompt?: string; onProgress?: (pct: number) => void }): Promise<Generated3d> {
  const id = await submit3dTask(cfg, { model: opts.model, image_url: opts.imageUrl, ...(opts.prompt ? { prompt: opts.prompt } : {}) });
  return downloadMesh(await poll3dTask(cfg, id, opts.onProgress));
}
