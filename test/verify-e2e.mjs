// End-to-end smoke test for the built extension.
//
//   npm run build          # produces .output/chrome-mv3
//   node test/verify-e2e.mjs
//
// On Linux CI wrap with a virtual display so MV3 service workers wake up:
//   xvfb-run -a node test/verify-e2e.mjs
//
// Requires: npm i -D playwright  (then: npx playwright install chromium)
import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import assert from 'node:assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const pathToExtension = resolve(root, '.output/chrome-mv3');

async function getServiceWorker(context) {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  return sw;
}

async function run() {
  // A persistent context with a real (non-headless) display is required:
  // headless Chromium does not reliably load MV3 service workers.
  const context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${pathToExtension}`,
      `--load-extension=${pathToExtension}`,
    ],
  });

  try {
    const sw = await getServiceWorker(context);
    console.log('✓ service worker loaded:', sw.url());

    // Start recording by messaging the background worker directly.
    const started = await sw.evaluate(
      () =>
        new Promise((res) =>
          chrome.runtime.sendMessage({ type: 'START' }, (r) => res(r)),
        ),
    );
    assert.ok(started?.ok && started.isRecording, 'recording should start');
    console.log('✓ recording started');

    const page = await context.newPage();
    await page.goto(pathToFileURL(resolve(root, 'test', 'index.html')).href);

    // Drive the form — each interaction should become one recorded step.
    await page.fill('#name', 'Jane Doe');
    await page.fill('#email', 'jane@example.com');
    await page.selectOption('#color', 'pro');
    await page.check('#agree');
    await page.click('button[type="submit"]');

    await page.waitForTimeout(500); // let messages flush to the worker

    const state = await sw.evaluate(
      () =>
        new Promise((res) =>
          chrome.runtime.sendMessage({ type: 'GET_STATE' }, (r) => res(r)),
        ),
    );

    console.log(`✓ captured ${state.steps.length} steps:`);
    for (const s of state.steps) {
      console.log(`   ${s.type.padEnd(7)} ${s.label}${s.value ? ` = "${s.value}"` : ''}`);
    }

    assert.ok(state.steps.length >= 5, 'expected at least 5 steps');
    const labels = state.steps.map((s) => s.label);
    assert.ok(labels.some((l) => /your name/i.test(l)), 'should capture "Your name"');
    assert.ok(labels.some((l) => /email/i.test(l)), 'should capture "Email"');
    assert.ok(
      state.steps.some((s) => s.type === 'submit'),
      'should capture form submit',
    );

    console.log('\n✅ E2E passed');
  } finally {
    await context.close();
  }
}

run().catch((err) => {
  console.error('\n❌ E2E failed:', err.message);
  process.exit(1);
});
