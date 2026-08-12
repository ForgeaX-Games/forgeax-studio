import { createServer } from 'node:net';

export interface RuntimePorts {
  readonly server: number;
  readonly engine: number;
  readonly interface: number;
}

export async function allocatePort(preferred?: number): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(preferred ?? 0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : undefined;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!port) throw new Error('runtime port allocator did not receive a port');
  return port;
}

/** Allocate a non-conflicting set without opening a long-lived listener. */
export async function allocateRuntimePorts(preferred: Partial<RuntimePorts> = {}): Promise<RuntimePorts> {
  const used = new Set<number>();
  const next = async (requested?: number): Promise<number> => {
    let value = await allocatePort(requested);
    while (used.has(value)) value = await allocatePort();
    used.add(value);
    return value;
  };
  const server = await next(preferred.server);
  const engine = await next(preferred.engine);
  const interfacePort = await next(preferred.interface);
  return { server, engine, interface: interfacePort };
}
