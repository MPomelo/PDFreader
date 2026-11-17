// Explicit opt-in paid smoke check. Sends two fixed short samples only. Never
// prints or reads a key into JavaScript and never changes the user's API config.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
const provider = process.argv[2];
if (!['mimo','deepseek'].includes(provider) || !process.argv.includes('--run-fixed-samples')) throw Error('Use: node scripts/probe-stage04-provider.mjs mimo --run-fixed-samples');
const { chromium } = createRequire(import.meta.url)('playwright');
const port = 14685;
const app = spawn(resolve('src-tauri/target/release/pdfreader.exe'), [], { windowsHide: true,
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`, WEBVIEW2_USER_DATA_FOLDER: resolve('.local/stage04-provider-qa') } });
let browser, page;
const evidence = { provider, date: new Date().toISOString(), requestLimit: 2, samples: [], keyInJavaScript: false, configChanged: false };
try {
  let version;
  for (let i = 0; i < 50; ++i) { try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) })).json(); break; } catch { await new Promise(resolve => setTimeout(resolve, 200)); } }
  if (!version) throw Error('Native endpoint unavailable');
  browser = await chromium.connectOverCDP(version.webSocketDebuggerUrl); page = browser.contexts()[0].pages()[0];
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
  for (const kind of ['test','math-test']) {
    const result = await page.evaluate(async ({provider,kind}) => {
      const invoke = window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__);
      const config = await invoke('api_load');
      const host = provider === 'mimo' ? 'api.xiaomimimo.com' : 'api.deepseek.com';
      const profile = config.profiles.find(profile => profile.provider === provider && new URL(profile.baseUrl).hostname === host);
      if (!profile) return { kind, status:'missing_official_profile' };
      const status = await invoke('api_secret_status', { profileId:profile.id });
      if (!status.available) return { kind, status:'missing_key' };
      const requestId=crypto.randomUUID(), documentId='fixed-stage04-validation';
      const chunks=[];
      const callback=window.__TAURI_INTERNALS__.transformCallback(raw=>{ if(raw.message) chunks.push(raw.message); });
      try {
        const response=await invoke('api_stream_request',{ request:{requestId,documentId,profileId:profile.id,kind,text:''},onChunk:'__CHANNEL__:'+callback });
        return {kind,status:'passed',requestedModel:profile.model,actualModel:response.model,text:response.text,elapsedMs:response.elapsedMs,usage:response.usage,chunks:chunks.length,idsMatch:response.requestId===requestId&&response.documentId===documentId,thoughtSeparated:!response.reasoning||!response.text.includes(response.reasoning)};
      } catch(error) { return {kind,status:'failed',model:profile.model,error:String(error)}; }
      finally { window.__TAURI_INTERNALS__.unregisterCallback(callback); }
    }, {provider,kind});
    evidence.samples.push(result);
    if (result.status !== 'passed') break; // No silent retries or provider fallback.
  }
} catch(error) { evidence.error = String(error); }
finally {
  writeFileSync(`test-results/stage04/${provider}-real-smoke.json`, JSON.stringify(evidence,null,2));
  console.log(JSON.stringify(evidence,null,2));
  if(page&&!page.isClosed()){try{await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('finish_close'));}catch{}}
  if(browser){try{await browser.close();}catch{}}
  if(app.exitCode==null)app.kill();
}
