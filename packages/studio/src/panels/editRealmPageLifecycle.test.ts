import { expect, test } from 'bun:test';
import { installEditRealmPageLifecycle } from './editRealmPageLifecycle';

test('releases the WebGPU edit realm before a real page navigation', () => {
  let pagehideListener: EventListener | undefined;
  let removedListener: EventListener | undefined;
  let resets = 0;
  const target = {
    addEventListener(type: 'pagehide', listener: EventListener) {
      expect(type).toBe('pagehide');
      pagehideListener = listener;
    },
    removeEventListener(type: 'pagehide', listener: EventListener) {
      expect(type).toBe('pagehide');
      removedListener = listener;
    },
  };

  const uninstall = installEditRealmPageLifecycle(target, () => { resets += 1; });
  expect(pagehideListener).toBeDefined();

  pagehideListener!(Object.assign(new Event('pagehide'), { persisted: true }));
  expect(resets).toBe(0);

  pagehideListener!(Object.assign(new Event('pagehide'), { persisted: false }));
  expect(resets).toBe(1);

  uninstall();
  expect(removedListener).toBe(pagehideListener);
});
