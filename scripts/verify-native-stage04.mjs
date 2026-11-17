import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const { chromium } = createRequire(import.meta.url)('playwright');
const port = 14684;
const app = spawn(resolve('src-tauri/target/release/pdfreader.exe'), [resolve('test-results/stage02/reading.pdf')], {
  windowsHide: true,
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`, WEBVIEW2_USER_DATA_FOLDER: resolve('.local/stage04-native-qa') },
});
let browser, page; const errors = [], evidence = []; let output = '';
app.stdout.on('data', bytes => output += bytes); app.stderr.on('data', bytes => output += bytes);
try {
  let version;
  for (let i = 0; i < 50; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) })).json(); break; }
    catch { if (app.exitCode != null) throw Error(`App exited ${app.exitCode}: ${output.slice(-500)}`); await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  if (!version) throw Error('Native debug endpoint did not become available');
  browser = await chromium.connectOverCDP(version.webSocketDebuggerUrl);
  page = browser.contexts()[0].pages()[0]; page.on('pageerror', error => errors.push(error.message));
  const frame = page.frameLocator('iframe');
  await frame.locator('.textLayer span').first().waitFor({ timeout: 15000 });
  const fingerprint = await frame.locator('body').evaluate(() => window.PDFViewerApplication.pdfDocument.fingerprints[0]);
  evidence.push('Production EXE starts in native Tauri/WebView2 and opens the synthetic PDF through its real startup/read path');
  await page.evaluate(() => { const original = window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__); window.nativePaidRequests = 0; window.__TAURI_INTERNALS__.invoke = (...args) => { if (['api_request','api_stream_request'].includes(args[0])) window.nativePaidRequests++; return original(...args); }; });
  await page.getByRole('button', { name: '文档导航', exact: true }).click();
  await page.getByRole('button', { name: '翻译侧栏', exact: true }).click();
  const right = page.getByRole('separator', { name: '调整右侧栏宽度' });
  const box = await right.boundingBox(); const before = await page.locator('.translation-shell').boundingBox();
  await page.mouse.move(box.x + 4, box.y + 80); await page.mouse.down(); await page.mouse.move(box.x - 116, box.y + 80, { steps: 10 }); await page.mouse.up();
  assert.ok((await page.locator('.translation-shell').boundingBox()).width >= before.width + 110);
  const left = page.getByRole('separator', { name: '调整左侧栏宽度' }); await left.focus(); await left.press('ArrowRight');
  assert.ok((await page.locator('.navigation-shell').boundingBox()).width >= 240);
  assert.ok((await page.locator('.reader').boundingBox()).width >= 360);
  assert.equal(await frame.locator('body').evaluate(() => window.PDFViewerApplication.pdfDocument.fingerprints[0]), fingerprint);
  evidence.push('Native pointer drag and keyboard resize work on both sidebars; PDF remains the same and retains a readable region');
  await frame.locator('.textLayer span').first().evaluate(element => { const range = document.createRange(); range.selectNodeContents(element); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); });
  await page.locator('.translation .selection').first().waitFor();
  assert.equal(await page.getByRole('checkbox', { name: /选区自动翻译/ }).isChecked(), false);
  assert.equal(await page.evaluate(() => window.nativePaidRequests), 0);
  evidence.push('Real native PDF text selection reaches the translation panel; auto translation starts off and these checks issue zero paid requests');
  const credentials = await page.evaluate(async () => {
    const config = await window.__TAURI_INTERNALS__.invoke('api_load');
    return await Promise.all(config.profiles.filter(profile => ['deepseek','mimo'].includes(profile.provider)).map(async profile => ({provider:profile.provider, ...(await window.__TAURI_INTERNALS__.invoke('api_secret_status',{profileId:profile.id}))})));
  });
  await page.screenshot({ path: 'test-results/stage04/native-reader-resized.png' });
  await page.getByRole('button', { name: '专注阅读', exact: true }).click(); assert.equal(await page.locator('aside').count(), 0);
  evidence.push('Native focus mode removes both sidebars without leftover width');
  assert.equal(errors.length, 0, errors.join('\n'));
  writeFileSync('test-results/stage04/native-desktop-evidence.json', JSON.stringify({ environment: 'production Tauri EXE, isolated WebView2 data folder, real native IPC/file/resize paths; no API config changes, no provider calls', evidence, credentials, errors }, null, 2));
  console.log(JSON.stringify({ passed: evidence.length, credentials, errors }, null, 2));
} finally {
  if (page && !page.isClosed()) { try { await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('finish_close')); } catch {} }
  if (browser) { try { await browser.close(); } catch {} }
  if (app.exitCode == null) app.kill();
}
