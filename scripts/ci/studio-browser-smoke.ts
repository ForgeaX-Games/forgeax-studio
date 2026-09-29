#!/usr/bin/env bun
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../..');
const manifest = JSON.parse(readFileSync(join(root, '.forgeax/runtime/manifest.json'), 'utf8'));
const requireIde = createRequire(join(root, 'packages/ide/package.json'));
const { chromium } = requireIde('playwright-core');
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-webgpu'],
});
const output = join(root, '.forgeax/runtime/browser-smoke');
mkdirSync(output, { recursive: true });
const errors: string[] = [];
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
try {
  page.on('pageerror', (error: Error) => errors.push(error.message));
  const response = await page.goto(manifest.endpoints.interface.origin, { waitUntil: 'domcontentloaded' });
  if (!response?.ok()) throw new Error(`IDE navigation failed: ${response?.status()}`);
  const shell = page.locator('.studio-shell');
  const skipConnect = page.getByRole('button', { name: 'Skip setup', exact: true });
  await shell.or(skipConnect).first().waitFor({ state: 'visible', timeout: 60_000 });
  if (await skipConnect.isVisible()) {
    await skipConnect.click();
    await page.getByPlaceholder('Optional; leave blank for untitled-1').fill(`release-smoke-${process.pid}`);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
  }
  await shell.waitFor({ state: 'visible', timeout: 60_000 });
  if (!(await shell.innerText()).trim() || await page.locator('.studio-main-dock').count() !== 1) {
    throw new Error('IDE shell did not mount its main dock');
  }
  await page.reload({ waitUntil: 'domcontentloaded' });
  await shell.waitFor({ state: 'visible', timeout: 30_000 });
  if (await page.locator('.studio-main-dock').count() !== 1) throw new Error('IDE main dock missing after reload');
  await page.waitForTimeout(3_000);
  if (await page.locator('vite-error-overlay').count()) throw new Error('IDE displays a Vite error overlay');
  if (errors.length) throw new Error(`IDE browser errors:\n${errors.join('\n')}`);
  console.log(JSON.stringify({ stage: 'browser-smoke', status: 'passed', title: await page.title(), url: page.url() }));
} catch (error) {
  console.error(JSON.stringify({ stage: 'browser-smoke', errors, text: await page.locator('body').innerText() }));
  throw error;
} finally {
  await page.screenshot({ path: join(output, 'ide.png'), fullPage: true }).catch((error: Error) => {
    console.error(`Unable to capture IDE diagnostics: ${error.message}`);
  });
  await browser.close();
}
