import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'studio-lifecycle-smoke.sh'), 'utf8');

describe('Studio lifecycle smoke', () => {
  it('serializes an isolated RuntimeInstance and cleans it through the public command', () => {
    expect(source).toContain('flock --wait 600 9');
    expect(source).toContain('bun fx instance init --slot "$slot" --isolate-user --force');
    expect(source).toContain('trap cleanup EXIT INT TERM');
    expect(source).toContain('bun fx stop --force');
    expect(source).not.toContain('pkill');
  });

  it('starts, probes, restarts, probes again, and stops through bun fx', () => {
    const start = source.indexOf('bun fx start web');
    const firstProbe = source.indexOf('probe_stack', start);
    const restart = source.indexOf('bun fx restart', firstProbe);
    const secondProbe = source.indexOf('probe_stack', restart);
    const stop = source.indexOf('bun fx stop\n', secondProbe);

    expect(start).toBeGreaterThan(-1);
    expect(firstProbe).toBeGreaterThan(start);
    expect(restart).toBeGreaterThan(firstProbe);
    expect(secondProbe).toBeGreaterThan(restart);
    expect(stop).toBeGreaterThan(secondProbe);
    expect(source).toContain('manifest.endpoints.server.healthPath');
    expect(source).toContain('manifest.endpoints.interface.healthPath');
    expect(source).toContain('manifest.endpoints.engine.healthPath');
  });
});
