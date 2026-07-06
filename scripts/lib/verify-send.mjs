// verify-send.mjs — headless-drive the real Studio UI to send ONE forgeax turn.
//
// Why a real browser (not curl/WS): the forgeax turn only fires after the UI's
// WS-open path attaches + starts the agent scheduler; a bare POST /messages (or
// WS-open + POST) does NOT schedule a turn. Playwright reproduces the human path
// exactly. We only SEND here — the pass/fail verdict is read from the session's
// logs/trace.jsonl by the bash orchestrator (robust, no DOM scraping).
//
// Usage: bun scripts/lib/verify-send.mjs <uiUrl> <message>
//
// playwright is a transitive dep in bun's .bun store (not hoisted / not a bare-
// resolvable name from here), so locate its store entry at runtime and import by
// absolute path — version-agnostic (globs playwright@*).
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

function resolvePlaywright() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const store = join(root, 'node_modules', '.bun');
  const hit = readdirSync(store).find((d) => d.startsWith('playwright@'));
  if (!hit) throw new Error(`playwright not found under ${store}`);
  return join(store, hit, 'node_modules', 'playwright', 'index.js');
}
const { chromium } = await import(resolvePlaywright());

const [uiUrl, message] = process.argv.slice(2);
if (!uiUrl || !message) {
  console.error('usage: bun verify-send.mjs <uiUrl> <message>');
  process.exit(2);
}

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newContext().then((c) => c.newPage());
  await page.goto(uiUrl, { waitUntil: 'networkidle', timeout: 45_000 }).catch(() => {});
  // The chat composer is a contenteditable <div> in the main frame (the visible
  // "Type your game idea…" is a CSS placeholder overlay, not a real attribute).
  const box = page.locator('div[contenteditable="true"]').first();
  await box.waitFor({ state: 'visible', timeout: 45_000 });
  // A cold stack shows the composer before the WS/session is ready to accept a
  // submit; settle first, else Enter no-ops and no turn is scheduled.
  await page.waitForTimeout(5000);
  // Submit, then confirm the composer cleared (a real submit empties it). Retry
  // a couple times to ride out the hydration race.
  let sent = false;
  for (let attempt = 0; attempt < 3 && !sent; attempt++) {
    await box.click();
    await page.keyboard.type(message);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2500);
    const leftover = (await box.textContent().catch(() => '')) || '';
    if (!leftover.includes(message.slice(0, 12))) { sent = true; break; }
    await page.waitForTimeout(2500);
  }
  console.log(sent ? 'SENT' : 'SENT_UNCONFIRMED');
} finally {
  await browser.close();
}
