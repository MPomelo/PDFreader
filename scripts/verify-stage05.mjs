import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import './stage04-fixtures.mjs';
mkdirSync('test-results/stage05',{recursive:true});
const { chromium } = createRequire(import.meta.url)('playwright');
const server=spawn(process.execPath,[resolve('node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port','1426','--strictPort'],{windowsHide:true});
let output='';server.stdout.on('data',b=>output+=b);server.stderr.on('data',b=>output+=b);
let browser,page;const errors=[],evidence=[];
try {
 let ready=false;for(let i=0;i<40;i++){try{if((await fetch('http://127.0.0.1:1426')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,150));}assert.ok(ready,output);
 browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:['--disable-crash-reporter']});
 const context=await browser.newContext({viewport:{width:1280,height:720},colorScheme:'dark',acceptDownloads:true});page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:1426/test-results/stage04/app.html');
 const frame=page.frameLocator('iframe');
 async function initialized(){await frame.locator('body').waitFor({state:'attached',timeout:60000});await frame.locator('body').evaluate(async()=>{const deadline=Date.now()+60000;while(!window.PDFViewerApplication?.initialized){if(Date.now()>deadline)throw Error('Viewer not initialized');await new Promise(r=>setTimeout(r,100));}});}
 async function flush(){await page.evaluate(async()=>{const {repository}=await import('/src/local/repository.ts');await repository.flush();});}
 async function select(index=0,pageNumber=1){await frame.locator(`.page[data-page-number="${pageNumber}"] .textLayer span`).nth(index).evaluate(element=>{const range=document.createRange();range.selectNodeContents(element);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);});await page.getByRole('button',{name:'浮窗翻译',exact:true}).waitFor();}
 async function complete(){await page.locator('.translation-result .stream-status').filter({hasText:'已完成'}).waitFor({timeout:15000});await flush();}
 async function options(){if(!await page.locator('.translation-options').evaluate(el=>el.open))await page.locator('.translation-options>summary').click();}
 const calls=()=>page.evaluate(()=>window.fixtureCalls.length);
 await initialized();await page.locator('input[type=file]').setInputFiles(resolve('test-results/stage02/reading.pdf'));await frame.locator('.textLayer span').first().waitFor();
 assert.equal(await page.locator('html').getAttribute('data-theme'),'light');assert.equal(await frame.locator('html').getAttribute('data-theme'),'light');
 const lightIcon=await frame.locator('#zoomInButton').evaluate(el=>getComputedStyle(el,'::before').backgroundColor);assert.equal(lightIcon,'rgb(36, 36, 36)');
 await page.evaluate(()=>{window.fixtureDelay=1;});await select();await page.getByRole('button',{name:'浮窗翻译',exact:true}).click();await complete();
 assert.equal(await page.locator('.floating-translation').count(),1);assert.equal(await calls(),1);const source=await page.locator('.translation-source').inputValue();
 await page.getByRole('button',{name:'固定到侧栏',exact:true}).click();assert.equal(await page.locator('.floating-translation').count(),0);assert.equal(await page.locator('.translation-source').inputValue(),source);assert.equal(await calls(),1);
 evidence.push('Real PDF selection opens one shared floating renderer, pins to sidebar without a second call; forced light theme stays legible under dark OS preference');
 await page.getByRole('button',{name:'保存为笔记',exact:true}).click();await page.getByText('笔记已保存，可在文档导航的“笔记”中查看和导出。',{exact:true}).waitFor();await flush();
 await select();await page.getByRole('button',{name:'翻译选区',exact:true}).click();await complete();assert.equal(await calls(),1);await page.getByText('来自本地缓存 · 重新翻译可请求新结果',{exact:true}).waitFor();
 await page.getByRole('button',{name:'重新翻译',exact:true}).click();await complete();assert.equal(await calls(),2);
 await options();await page.getByLabel('回答样式').selectOption('detailed');await page.getByRole('button',{name:'翻译选区',exact:true}).click();await complete();assert.equal(await calls(),3);
 evidence.push('Completed result becomes a persistent note; exact request uses cache; manual retranslation bypasses cache; answer-style changes invalidate identity');
 const entries=await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('pdfreader.local-v1.cache.')).reduce((n,k)=>n+JSON.parse(localStorage.getItem(k)).data.entries.length,0));
 await page.evaluate(()=>{window.fixtureDelay=200;window.fixtureIgnoreCancel=true;});await select(1);await page.getByRole('button',{name:'翻译选区',exact:true}).click();await page.getByText('正在接收 · 内容尚未完成',{exact:true}).waitFor();await page.getByRole('button',{name:'取消',exact:true}).click();await page.getByText('已取消 · 以下为未完成内容',{exact:true}).waitFor();await flush();
 assert.equal(await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('pdfreader.local-v1.cache.')).reduce((n,k)=>n+JSON.parse(localStorage.getItem(k)).data.entries.length,0)),entries);
 await select(0);await page.getByRole('button',{name:'翻译选区',exact:true}).click();await complete();const formalSource=await page.locator('.translation-source').inputValue();await page.waitForTimeout(8000);assert.equal(await page.locator('.translation-source').inputValue(),formalSource);assert.equal(await page.locator('.translation-result .stream-status').innerText(),'已完成');
 evidence.push('Cancelled partial result never enters cache; late A chunks and completion cannot overwrite a newer cached B');
 await page.getByRole('button',{name:'文档导航',exact:true}).click();await page.getByRole('tab',{name:'笔记',exact:true}).click();assert.equal(await page.locator('.library-item').count(),1);await page.locator('.library-item>button').click();await page.getByRole('dialog',{name:'翻译笔记'}).waitFor();assert.equal(await page.locator('.note-sheet .katex-display').count(),2);
 const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'导出此笔记',exact:true}).click();const download=await downloadPromise;assert.ok(readFileSync(await download.path(),'utf8').includes(source));
 await page.getByRole('button',{name:'关闭笔记',exact:true}).press('Escape');await page.getByRole('dialog',{name:'翻译笔记'}).waitFor({state:'detached'});
 await options();await page.getByRole('button',{name:'清除此文档译文缓存',exact:true}).click();await page.getByText('此文档缓存已清空，笔记不受影响。',{exact:true}).waitFor();assert.equal(await page.locator('.library-item').count(),1);
 evidence.push('Saved note uses shared math renderer and a keyboard modal; exported Markdown retains exact source; clearing cache retains the note');
 await page.getByRole('button',{name:'切换深色主题',exact:true}).click();await frame.locator('html[data-theme=dark]').waitFor();assert.equal(await frame.locator('#zoomInButton').evaluate(el=>getComputedStyle(el,'::before').backgroundColor),'rgb(238, 238, 238)');
 await frame.locator('#pageNumber').fill('2');await frame.locator('#pageNumber').press('Enter');await frame.locator('#scaleSelect').selectOption('page-width');await page.waitForTimeout(800);await flush();
 const stored=await page.evaluate(()=>JSON.parse(localStorage.getItem('pdfreader.local-v1.state.')).data);assert.equal(stored.recents[0].page,2);assert.equal(stored.recents[0].zoom,'page-width');
 await page.reload();await initialized();await page.locator('input[type=file]').setInputFiles(resolve('test-results/stage02/reading.pdf'));await frame.locator('.page[data-page-number="2"] .textLayer span').first().waitFor();assert.equal(await frame.locator('#pageNumber').inputValue(),'2');assert.equal(await frame.locator('#scaleSelect').inputValue(),'page-width');assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');assert.equal(await page.getByRole('button',{name:'文档导航',exact:true}).getAttribute('aria-pressed'),'true');
 await page.getByRole('tab',{name:'笔记',exact:true}).click();assert.equal(await page.locator('.library-item').count(),1);
 evidence.push('Page, zoom, panel switches and theme survive a real reload; same PDF content restores progress; note survives reopening');
 await page.evaluate(()=>{window.fixtureDelay=1;});await select(0,2);await page.getByRole('button',{name:'翻译选区',exact:true}).click();await complete();
 await page.screenshot({path:'test-results/stage05/dark-1280.png'});
 await page.getByRole('button',{name:'切换浅色主题',exact:true}).click();await frame.locator('html[data-theme=light]').waitFor();await page.screenshot({path:'test-results/stage05/light-1280.png'});
 await page.getByRole('button',{name:'专注阅读',exact:true}).click();assert.equal(await page.locator('aside').count(),0);const beforeHidden=await calls();await page.waitForTimeout(250);assert.equal(await page.locator('aside').count(),0);assert.equal(await calls(),beforeHidden);await page.getByRole('button',{name:'专注阅读',exact:true}).click();
 await page.setViewportSize({width:720,height:720});await page.screenshot({path:'test-results/stage05/light-720.png'});assert.ok((await page.locator('.translation-shell').boundingBox()).width<=720);
 const scaled=await browser.newContext({viewport:{width:1280,height:720},deviceScaleFactor:1.5,storageState:await context.storageState()});const scalePage=await scaled.newPage();scalePage.on('pageerror',e=>errors.push(e.message));await scalePage.goto(page.url());await scalePage.locator('.panel-heading').waitFor({timeout:60000});await scalePage.getByRole('tab',{name:'笔记',exact:true}).click();await scalePage.locator('.library-item>button').click();await scalePage.locator('.note-sheet .katex').first().waitFor();await scalePage.evaluate(()=>document.fonts.ready);await scalePage.screenshot({path:'test-results/stage05/note-150.png'});await scaled.close();
 evidence.push('Light/dark screenshots at 1280 and narrow 720, real 150% font rendering, focus-mode hiding; no background expansion');
 await page.setViewportSize({width:1280,height:720});await page.evaluate(()=>localStorage.setItem('pdfreader.local-v1.notes.','broken json'));await page.reload();await page.getByRole('alert').filter({hasText:'笔记'}).waitFor();assert.equal(await page.evaluate(()=>localStorage.getItem('pdfreader.local-v1.notes.')),'broken json');await page.getByRole('button',{name:'先备份原文件并恢复空数据',exact:true}).click();await page.getByText('原数据已备份，可重新载入',{exact:true}).waitFor();assert.ok(await page.evaluate(()=>Object.keys(localStorage).some(k=>k.includes('notes.')&&k.endsWith('.backup')&&localStorage.getItem(k)==='broken json')));
 evidence.push('Corrupt notes are reported without overwrite; explicit recovery preserves a backup before creating empty data');
 assert.deepEqual(errors,[]);writeFileSync('test-results/stage05/browser-evidence.json',JSON.stringify({environment:'real app/PDF.js in system Edge; explicitly mocked provider, browser repository fallback; no real provider requests',evidence,errors},null,2));console.log(JSON.stringify({passed:evidence.length,evidence,errors},null,2));
} catch(error) {writeFileSync('test-results/stage05/browser-failure.json',JSON.stringify({error:String(error),errors,output,body:await page?.locator('body').innerText().catch(()=>''),frames:await Promise.all((page?.frames()||[]).map(async frame=>({url:frame.url(),body:await frame.locator('body').innerText().catch(()=> '')})))},null,2));throw error;}
finally{if(browser)await browser.close();server.kill();}
