// Render the already captured fixed provider response; this sends no API request.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const smoke = JSON.parse(readFileSync('test-results/stage04/mimo-real-smoke.json', 'utf8'));
const sample = smoke.samples.find(sample => sample.kind === 'math-test' && sample.status === 'passed');
assert.ok(sample, 'A captured real fixed-formula response is required');
writeFileSync('test-results/stage04/real-formula.html', '<!doctype html><html lang="zh"><meta charset="utf-8"><div id="root"></div><script type="module" src="/test-results/stage04/real-formula.tsx"></script></html>');
writeFileSync('test-results/stage04/real-formula.tsx', `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {MarkdownRenderer} from '/src/translation/MarkdownRenderer.tsx';
import '/src/ui/styles.css';
createRoot(document.getElementById('root')).render(<main style={{display:'block',width:580,margin:'24px auto',padding:24,background:'white'}}><h2>MiMo 固定公式实测</h2><MarkdownRenderer source={${JSON.stringify(sample.text)}}/></main>);
`);
const { chromium } = createRequire(import.meta.url)('playwright');
const server = spawn(process.execPath, [resolve('node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '1424', '--strictPort'], { windowsHide: true });
let browser; let output = ''; const errors = [];
server.stdout.on('data', bytes => output += bytes); server.stderr.on('data', bytes => output += bytes);
try {
  let ready = false;
  for (let i = 0; i < 40; ++i) { try { if ((await fetch('http://127.0.0.1:1424')).ok) { ready = true; break; } } catch {} await new Promise(resolve => setTimeout(resolve, 150)); }
  assert.ok(ready, output);
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--disable-crash-reporter'] });
  const evidence = [];
  for (const scale of [1, 1.5]) {
    const page = await browser.newPage({ viewport: { width: 900, height: 520 }, deviceScaleFactor: scale });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:1424/test-results/stage04/real-formula.html');
    await page.locator('.katex').first().waitFor({ timeout: 60000 });
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.locator('.katex-error').count(), 0);
    assert.equal(await page.locator('.katex').count(), 2);
    assert.equal(await page.locator('annotation').first().textContent(), String.raw`L=\frac{1}{N}\sum_{i=1}^{N}(y_i-\hat{y}_i)^2`);
    assert.ok(await page.evaluate(() => [...document.fonts].some(font => font.family.startsWith('KaTeX') && font.status === 'loaded')));
    await page.screenshot({ path: `test-results/stage04/mimo-real-formula-${scale}.png` });
    evidence.push({ scale, math: 2, errors: 0, localFontsLoaded: true }); await page.close();
  }
  assert.deepEqual(errors, []);
  writeFileSync('test-results/stage04/real-formula-rendering.json', JSON.stringify({ providerCalls: 0, source: 'mimo-real-smoke.json; fixed math-test response only', evidence, errors }, null, 2));
  console.log(JSON.stringify({ evidence, errors }, null, 2));
} finally { if (browser) await browser.close(); server.kill(); }
