import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dispatch, errorMessage, MCP_PROTOCOL_VERSION, type JsonRpcMessage, type McpServerSpec } from './protocol';

const DEFAULT_BODY_LIMIT = 1024 * 1024;

export interface HttpMcpOptions {
  readonly host: string;
  readonly port: number;
  readonly path?: string;
  readonly authToken?: string;
  readonly requireAuth?: boolean;
  readonly allowedOrigins?: readonly string[];
  readonly bodyLimit?: number;
}

export interface RunningHttpMcpServer {
  readonly server: Server;
  readonly origin: string;
  readonly url: string;
  close(): Promise<void>;
}

function loopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  const body = `${JSON.stringify(payload)}\n`;
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'mcp-protocol-version': MCP_PROTOCOL_VERSION,
  });
  response.end(body);
}

function unauthorized(response: ServerResponse): void {
  response.setHeader('www-authenticate', 'Bearer');
  json(response, 401, { error: 'unauthorized' });
}

function authorized(request: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true;
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function originAllowed(request: IncomingMessage, allowed: ReadonlySet<string>): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  return allowed.has(origin);
}

async function readMessage(request: IncomingMessage, limit: number): Promise<JsonRpcMessage> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > limit) throw new Error(`request body exceeds ${limit} bytes`);
    chunks.push(buffer);
  }
  if (chunks.length === 0) throw new Error('request body is empty');
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('request body must be one JSON-RPC object');
  }
  return value as JsonRpcMessage;
}

export async function startHttpMcpServer<Ctx>(
  spec: McpServerSpec<Ctx>,
  options: HttpMcpOptions,
): Promise<RunningHttpMcpServer> {
  const endpointPath = options.path ?? '/mcp';
  const token = options.authToken?.trim() || undefined;
  if ((options.requireAuth || !loopbackHost(options.host)) && !token) {
    throw new Error('HTTP MCP authentication token is required for this listener');
  }
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;

  const server = createServer((request, response) => {
    void (async () => {
      const requestPath = new URL(request.url ?? '/', 'http://mcp.invalid').pathname;
      if (requestPath === '/healthz') {
        json(response, 200, { status: 'ok', name: spec.serverInfo.name, transport: 'streamable-http' });
        return;
      }
      if (requestPath !== endpointPath) {
        json(response, 404, { error: 'not_found' });
        return;
      }
      if (!originAllowed(request, allowedOrigins)) {
        json(response, 403, { error: 'origin_not_allowed' });
        return;
      }
      if (!authorized(request, token)) {
        unauthorized(response);
        return;
      }
      if (request.method !== 'POST') {
        response.setHeader('allow', 'POST');
        json(response, 405, { error: 'method_not_allowed' });
        return;
      }
      if (!(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        json(response, 415, { error: 'content_type_must_be_application_json' });
        return;
      }

      let message: JsonRpcMessage;
      try {
        message = await readMessage(request, bodyLimit);
      } catch (error) {
        json(response, 400, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: errorMessage(error) },
        });
        return;
      }

      try {
        const result = await dispatch(spec, message);
        if (result === null) {
          response.writeHead(202, { 'cache-control': 'no-store', 'mcp-protocol-version': MCP_PROTOCOL_VERSION });
          response.end();
          return;
        }
        json(response, 200, result);
      } catch (error) {
        json(response, 500, {
          jsonrpc: '2.0',
          id: message.id ?? null,
          error: { code: -32603, message: errorMessage(error) },
        });
      }
    })().catch((error) => {
      if (!response.headersSent) {
        json(response, 500, { error: 'internal_error', message: errorMessage(error) });
      } else {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  const displayHost = options.host === '::1' ? '[::1]' : options.host;
  const origin = `http://${displayHost}:${port}`;
  return {
    server,
    origin,
    url: `${origin}${endpointPath}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}
