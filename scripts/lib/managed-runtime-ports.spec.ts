import { describe, expect, test } from 'bun:test';
import { managedRuntimePorts } from './managed-runtime-ports.ts';

const core = { serverPort: 28_900, interfacePort: 28_920, enginePort: 25_173 };

describe('managedRuntimePorts', () => {
  test('records only the core listeners when no optional service starts', () => {
    expect(managedRuntimePorts({ ...core, extensions: [] })).toEqual({
      server: 28_900,
      interface: 28_920,
      engine: 25_173,
    });
  });

  test('adds only started optional listeners and all extension frontend/backend listeners', () => {
    expect(managedRuntimePorts({
      ...core,
      narrativePort: 28_930,
      rhiReviewerPort: 25_274,
      extensions: [
        { shortId: 'reel', frontendPort: 25_175, backendPort: 25_177 },
        { shortId: 'lowpoly', frontendPort: 25_180, backendPort: 25_182 },
      ],
    })).toEqual({
      server: 28_900,
      interface: 28_920,
      engine: 25_173,
      narrative: 28_930,
      'rhi-reviewer': 25_274,
      'plugin-reel-frontend': 25_175,
      'plugin-reel-backend': 25_177,
      'plugin-lowpoly-frontend': 25_180,
      'plugin-lowpoly-backend': 25_182,
    });
  });

  test('fails explicitly for duplicate listener ports', () => {
    expect(() => managedRuntimePorts({
      ...core,
      narrativePort: 28_900,
      extensions: [],
    })).toThrow(/duplicate listener ports/);
  });
});
