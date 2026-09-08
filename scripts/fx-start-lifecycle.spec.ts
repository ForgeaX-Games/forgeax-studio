import { expect, test } from 'bun:test';

test('start awaits readiness and restart uses source-runtime recovery', async () => {
  const source = await Bun.file(new URL('./fx.ts', import.meta.url)).text();
  const startStudioBody = source.slice(
    source.indexOf('async function startStudio('),
    source.indexOf('async function startWeb('),
  );

  expect(startStudioBody).toContain('return startWeb(');
  expect(source).toContain("case 'start':\n      await startStudio(plan.args);");
  expect(source).toContain("case 'restart':\n      await restartStack(plan.args);");
  expect(source).toContain("return startStudio(args, 'restart');");
  expect(source).toContain("approveUnownedStop: existing === 'restart' ? approveUnownedRuntimeStop : undefined");
  expect(source).toContain('refusing non-interactive termination; rerun in an interactive terminal to confirm');
  expect(source).toContain('stop these processes and continue? [y/N]');
});
