import type { ManagedRuntimePorts } from './runtime-state.ts';

export interface ManagedRuntimeExtensionPort {
  readonly shortId: string;
  readonly frontendPort: number;
  readonly backendPort: number;
}

export interface ManagedRuntimePortsOptions {
  readonly serverPort: number;
  readonly interfacePort: number;
  readonly enginePort: number;
  readonly narrativePort?: number;
  readonly rhiReviewerPort?: number;
  readonly extensions: readonly ManagedRuntimeExtensionPort[];
}

/** Builds the exact listener ownership record persisted for instance-scoped stop. */
export function managedRuntimePorts(options: ManagedRuntimePortsOptions): ManagedRuntimePorts {
  const entries: Array<readonly [string, number]> = [
    ['server', options.serverPort],
    ['interface', options.interfacePort],
    ['engine', options.enginePort],
    ...(options.narrativePort === undefined ? [] : [['narrative', options.narrativePort] as const]),
    ...(options.rhiReviewerPort === undefined ? [] : [['rhi-reviewer', options.rhiReviewerPort] as const]),
    ...options.extensions.flatMap((extension) => [
      [`plugin-${extension.shortId}-frontend`, extension.frontendPort] as const,
      [`plugin-${extension.shortId}-backend`, extension.backendPort] as const,
    ]),
  ];
  const invalid = entries.find(([name, port]) => !validName(name) || !validPort(port));
  if (invalid) throw new Error(`invalid managed runtime port '${invalid[0]}'=${invalid[1]}`);
  if (new Set(entries.map(([name]) => name)).size !== entries.length) {
    throw new Error('managed runtime ports contain duplicate service names');
  }
  if (new Set(entries.map(([, port]) => port)).size !== entries.length) {
    throw new Error('managed runtime ports contain duplicate listener ports');
  }
  return Object.fromEntries(entries) as ManagedRuntimePorts;
}

function validName(value: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(value) && value !== 'bridge';
}

function validPort(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= 65_535;
}
