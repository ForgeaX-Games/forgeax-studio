import type { ChildProcess } from 'node:child_process';
import {
  isAlive,
  killTree,
  spawnService,
  type SpawnOpts,
} from './proc.ts';
import type { RestartPolicy } from './startup-environment.ts';

export type ServiceStatus = 'starting' | 'running' | 'restarting' | 'failed' | 'stopped';

export interface ServiceEvent {
  readonly name: string;
  readonly status: ServiceStatus;
  readonly pid?: number;
  readonly attempt?: number;
  readonly error?: string;
}

export interface ManagedServiceSpec {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly spawn: SpawnOpts;
  readonly required?: boolean;
  readonly restartPolicy: RestartPolicy;
  readonly maxRestarts?: number;
}

interface ServiceSupervisorOptions {
  readonly onEvent?: (event: ServiceEvent) => void;
  readonly onFatal?: (error: Error) => void;
}

interface ManagedService {
  readonly spec: ManagedServiceSpec;
  child?: ChildProcess;
  restarts: number;
  stableTimer?: ReturnType<typeof setTimeout>;
}

export class ServiceSupervisor {
  private readonly services = new Map<string, ManagedService>();
  private shuttingDown = false;

  constructor(private readonly options: ServiceSupervisorOptions = {}) {}

  launch(spec: ManagedServiceSpec): number {
    if (this.services.has(spec.name)) throw new Error(`service '${spec.name}' is already managed`);
    const service: ManagedService = { spec, restarts: 0 };
    this.services.set(spec.name, service);
    return this.spawn(service);
  }

  pids(): Record<string, number> {
    return Object.fromEntries(
      [...this.services.entries()]
        .map(([name, service]) => [name, service.child?.pid ?? 0] as const)
        .filter(([, pid]) => pid > 0),
    );
  }

  shutdown(force = false): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    for (const service of this.services.values()) {
      if (service.stableTimer) clearTimeout(service.stableTimer);
      const pid = service.child?.pid ?? 0;
      if (pid && isAlive(pid)) killTree(pid, force);
      this.emit({ name: service.spec.name, status: 'stopped', ...(pid ? { pid } : {}) });
    }
  }

  private spawn(service: ManagedService): number {
    const { spec } = service;
    this.emit({
      name: spec.name,
      status: service.restarts === 0 ? 'starting' : 'restarting',
      ...(service.restarts > 0 ? { attempt: service.restarts } : {}),
    });
    const child = spawnService(spec.command, [...spec.args], spec.spawn);
    service.child = child;
    const pid = child.pid ?? 0;
    this.emit({ name: spec.name, status: 'running', ...(pid ? { pid } : {}) });

    let settled = false;
    const failed = (message: string): void => {
      if (settled) return;
      settled = true;
      if (service.stableTimer) clearTimeout(service.stableTimer);
      service.child = undefined;
      if (this.shuttingDown) return;
      void this.handleUnexpectedExit(service, message);
    };
    child.once('error', (error) => failed(error.message));
    child.once('exit', (code, signal) => {
      failed(signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`);
    });

    service.stableTimer = setTimeout(() => {
      service.restarts = 0;
    }, 30_000);
    service.stableTimer.unref?.();
    return pid;
  }

  private async handleUnexpectedExit(service: ManagedService, detail: string): Promise<void> {
    const { spec } = service;
    if (spec.restartPolicy === 'bounded' && service.restarts < (spec.maxRestarts ?? 5)) {
      const attempt = service.restarts + 1;
      service.restarts = attempt;
      this.emit({
        name: spec.name,
        status: 'restarting',
        attempt,
        error: detail,
      });
      await Bun.sleep(Math.min(500 * 2 ** (attempt - 1), 8_000));
      if (!this.shuttingDown) this.spawn(service);
      return;
    }

    const role = spec.required === false ? 'optional service' : 'required service';
    const error = new Error(`${role} '${spec.name}' exited unexpectedly (${detail})`);
    this.emit({ name: spec.name, status: 'failed', error: error.message });
    if (spec.required !== false) this.options.onFatal?.(error);
  }

  private emit(event: ServiceEvent): void {
    this.options.onEvent?.(event);
  }
}
