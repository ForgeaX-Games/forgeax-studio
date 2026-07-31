import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { RuntimeReadiness } from './runtime-readiness.ts';
import {
  isStartupProfile,
  type StartupEnvironment,
  sanitizedStartupEnvironment,
} from './startup-environment.ts';

export type RuntimeStatus = 'starting' | 'ready' | 'failed' | 'stopping';

export interface RuntimeState {
  readonly schemaVersion: 1;
  readonly profile: StartupEnvironment['profile'];
  readonly status: RuntimeStatus;
  readonly launcherPid: number;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly publicOrigin: string;
  readonly startup: StartupEnvironment;
  readonly servicePids: Readonly<Record<string, number>>;
  readonly readiness?: RuntimeReadiness;
  readonly error?: string;
}

export class RuntimeStateStore {
  private readonly startedAt = new Date().toISOString();
  private status: RuntimeStatus = 'starting';
  private servicePids: Record<string, number> = {};
  private readiness?: RuntimeReadiness;
  private error?: string;

  constructor(
    private readonly startup: StartupEnvironment,
    private readonly launcherPid: number = process.pid,
  ) {}

  writeStarting(): RuntimeState {
    this.status = 'starting';
    return this.write();
  }

  setServicePid(name: string, pid: number): RuntimeState {
    if (pid > 0) this.servicePids[name] = pid;
    else delete this.servicePids[name];
    return this.write();
  }

  setReadiness(readiness: RuntimeReadiness): RuntimeState {
    this.readiness = readiness;
    return this.write();
  }

  markReady(readiness: RuntimeReadiness): RuntimeState {
    this.status = 'ready';
    this.readiness = readiness;
    this.error = undefined;
    return this.write();
  }

  markFailed(error: string, readiness?: RuntimeReadiness): RuntimeState {
    this.status = 'failed';
    this.error = error;
    if (readiness) this.readiness = readiness;
    return this.write();
  }

  markStopping(): RuntimeState {
    this.status = 'stopping';
    return this.write();
  }

  remove(): void {
    rmSync(this.startup.stateFile, { force: true });
  }

  private write(): RuntimeState {
    const state: RuntimeState = {
      schemaVersion: 1,
      profile: this.startup.profile,
      status: this.status,
      launcherPid: this.launcherPid,
      startedAt: this.startedAt,
      updatedAt: new Date().toISOString(),
      publicOrigin: this.startup.interface.publicOrigin,
      startup: sanitizedStartupEnvironment(this.startup),
      servicePids: { ...this.servicePids },
      ...(this.readiness ? { readiness: this.readiness } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
    mkdirSync(dirname(this.startup.stateFile), { recursive: true });
    const temporary = `${this.startup.stateFile}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(temporary, this.startup.stateFile);
    return state;
  }
}

export function readRuntimeState(path: string): RuntimeState | null {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as RuntimeState;
    if (
      value.schemaVersion !== 1
      || !isStartupProfile(value.profile)
      || !['starting', 'ready', 'failed', 'stopping'].includes(value.status)
      || !Number.isInteger(value.launcherPid)
      || typeof value.publicOrigin !== 'string'
      || value.startup?.profile !== value.profile
      || !validEndpoint(value.startup?.server)
      || !validEndpoint(value.startup?.interface)
      || !validEndpoint(value.startup?.engine)
      || typeof value.startup?.gatewayBridge?.enabled !== 'boolean'
      || !Number.isInteger(value.startup?.gatewayBridge?.port)
      || typeof value.servicePids !== 'object'
      || value.servicePids === null
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function validEndpoint(value: unknown): value is StartupEnvironment['server'] {
  if (typeof value !== 'object' || value === null) return false;
  const endpoint = value as Partial<StartupEnvironment['server']>;
  return (
    typeof endpoint.host === 'string'
    && Number.isInteger(endpoint.port)
    && (endpoint.port ?? 0) > 0
    && (endpoint.port ?? 0) <= 65_535
    && typeof endpoint.healthPath === 'string'
  );
}
