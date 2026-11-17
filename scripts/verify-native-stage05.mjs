// Actual native persistence and desktop UI with a preloaded synthetic note.
// No provider request is made. Restore pre-test
// state/notes logically using revision checks, never overwrite a newer writer.
import { spawn, execFile, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const { chromium }=createRequire(import.meta.url)('playwright');
mkdirSync('test-results/stage05',{recursive:true});
const roaming=process.env.APPDATA || execFileSync('powershell.exe',['-NoProfile','-Command',"[Environment]::GetFolderPath('ApplicationData')"],{windowsHide:true,encoding:'utf8'}).trim();
const localDir=join(roaming,'local.pomelo.pdfreader','local-v1');
const fingerprint=createHash('sha256').update(readFileSync('test-results/stage02/reading.pdf')).digest('hex');
const before=Object.fromEntries(['state','notes'].map(kind=>{const path=join(localDir,kind+'.json');return[kind,existsSync(path)?JSON.parse(readFileSync(path,'utf8')):null];}));
let app,browser,page,expectedLayout;const evidence=[],errors=[],scales=[];let port=14686;const qaId='stage05-native-'+Date.now();
const markdown=String.raw`固定本地验收：$L=\frac{1}{N}\sum_i x_i^2$。

$$
\mathbf{A}=\begin{bmatrix}1&2\\3&4\end{bmatrix}
$$`;
async function launch(){
 const scale=port===14686?1:1.5;
 app=spawn(resolve('src-tauri/target/release/pdfreader.exe'),[resolve('test-results/stage02/reading.pdf')],{windowsHide:true,env:{...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port} --force-device-scale-factor=${scale}`,WEBVIEW2_USER_DATA_FOLDER:resolve('.local/stage05-native-qa')}});
 let version;for(let i=0;i<60;i++){try{version=await(await fetch(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(1000)})).json();break;}catch{await new Promise(r=>setTimeout(r,200));}}assert.ok(version,'Native endpoint unavailable');
 browser=await chromium.connectOverCDP(version.webSocketDebuggerUrl);page=browser.contexts()[0].pages()[0];page.on('pageerror',e=>errors.push(e.message));await page.frameLocator('iframe').locator('.textLayer span').first().waitFor({timeout:20000});
 const ratio=await page.evaluate(()=>devicePixelRatio);assert.equal(ratio,scale);scales.push(ratio);
}
async function invoke(command,args={}){return page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});}
async function stop(){if(page&&!page.isClosed()){try{await invoke('finish_close');}catch{}}if(browser){try{await browser.close();}catch{}}if(app?.exitCode==null)app?.kill();page=browser=null;}
try{
 await launch();let frame=page.frameLocator('iframe');
 const initialNotes=await invoke('local_read',{kind:'notes',document:''});
 const qaNote={id:qaId,fingerprint,name:'reading.pdf',page:1,original:'Synthetic QA title',originalRaw:'Synthetic QA title',markdown,model:'local-qa-fixture',service:'local-qa-fixture',domain:'QA only',language:'中文',time:new Date().toISOString()};
 await invoke('local_write',{kind:'notes',document:'',revision:initialNotes.revision,data:{version:1,notes:[qaNote,...(initialNotes.data?.notes||[])]}});
 if(await page.getByRole('button',{name:'翻译侧栏',exact:true}).getAttribute('aria-pressed')!=='true')await page.getByRole('button',{name:'翻译侧栏',exact:true}).click();
 evidence.push('Production EXE/WebView2 opens the real synthetic PDF; a synthetic math note is persisted via actual native IPC without invoking a provider');
 if(await page.getByRole('button',{name:'文档导航',exact:true}).getAttribute('aria-pressed')!=='true')await page.getByRole('button',{name:'文档导航',exact:true}).click();
 const left=page.getByRole('separator',{name:'调整左侧栏宽度'});await left.focus();await left.press('ArrowRight');
 await frame.locator('#pageNumber').fill('2');await frame.locator('#pageNumber').press('Enter');await frame.locator('#scaleSelect').selectOption('page-width');
 if(await page.locator('html').getAttribute('data-theme')!=='dark')await page.getByRole('button',{name:'切换深色主题',exact:true}).click();await frame.locator('html[data-theme=dark]').waitFor();await page.waitForTimeout(1000);
 const saved=await invoke('local_read',{kind:'state',document:''});expectedLayout=saved.data.layout;const savedRecent=saved.data.recents.find(r=>r.fingerprint===fingerprint);assert.equal(savedRecent.page,2);assert.equal(savedRecent.zoom,'page-width');
 const notes=await invoke('local_read',{kind:'notes',document:''});assert.ok(notes.data.notes.some(n=>n.markdown===markdown));
 evidence.push('Native atomic JSON contains saved note source, page 2, page-width zoom, dark theme and resized layout');
 await page.screenshot({path:'test-results/stage05/native-dark.png'});await stop();port++;await launch();frame=page.frameLocator('iframe');
 await frame.locator('.page[data-page-number="2"] .textLayer span').first().waitFor();assert.equal(await frame.locator('#pageNumber').inputValue(),'2');assert.equal(await frame.locator('#scaleSelect').inputValue(),'page-width');assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');assert.equal(await page.locator('.navigation-shell').evaluate(el=>Math.round(el.getBoundingClientRect().width)),Math.round(saved.data.layout.leftWidth));
 await page.getByRole('tab',{name:'笔记',exact:true}).click();const entry=page.locator('.library-item').filter({hasText:'local-qa-fixture'}).first();await entry.locator('button').first().click();await page.locator('.note-sheet .katex').first().waitFor();assert.equal(await page.locator('.note-sheet .katex-error').count(),0);await page.screenshot({path:'test-results/stage05/native-reopened-note.png'});
 evidence.push('A different native process restores the saved page/zoom/theme/sidebar width and reopens a readable mathematical note');
 const target=resolve('test-results/stage05',`native-notes-${Date.now()}.md`);
 await page.getByRole('button',{name:'导出此笔记',exact:true}).click();
 await new Promise((resolvePromise,reject)=>execFile('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',resolve('scripts/save-stage05-dialog.ps1'),'-AppProcessId',String(app.pid),'-TargetPath',target],{windowsHide:true,timeout:20000},(error,stdout,stderr)=>error?reject(Error(String(error)+' '+stderr)):resolvePromise(stdout)));
 for(let i=0;i<50&&!existsSync(target);i++)await new Promise(r=>setTimeout(r,100));assert.ok(existsSync(target));assert.ok(readFileSync(target,'utf8').includes(markdown));
 await page.getByRole('button',{name:'关闭笔记',exact:true}).click();
 evidence.push('Real Windows Save dialog exports a Markdown file whose mathematical source exactly matches the saved native note');
 assert.deepEqual(errors,[]);writeFileSync('test-results/stage05/native-evidence.json',JSON.stringify({exeSha256:createHash('sha256').update(readFileSync('src-tauri/target/release/pdfreader.exe')).digest('hex').toUpperCase(),environment:'production EXE, native persistence and native Save dialog; WebView2 forced scale 100%/150%, Windows global display preferences untouched; synthetic note preloaded through IPC, no provider calls in the successful run; failed earlier interceptor run sent one synthetic PDF title to MiMo (225 tokens), recorded separately',evidence,scales,errors},null,2));console.log(JSON.stringify({passed:evidence.length,evidence,scales,errors},null,2));
}catch(error){writeFileSync('test-results/stage05/native-failure.json',JSON.stringify({error:String(error),errors,body:await page?.locator('body').innerText().catch(()=> '')},null,2));throw error;}
finally{
 if(page&&!page.isClosed()){
  await page.waitForTimeout(1200);
  for(const kind of ['state','notes'])try{
   const document='';const current=await invoke('local_read',{kind,document});
   if(kind==='notes'){
    const remaining=(current.data?.notes||[]).filter(note=>note.id!==qaId);
    if(!before.notes&&!remaining.length)await invoke('local_recover',{kind,document});
    else await invoke('local_write',{kind,document,revision:current.revision,data:{...current.data,version:1,notes:remaining}});
   }else{
    const others=(current.data?.recents||[]).filter(r=>r.fingerprint!==fingerprint), original=(before.state?.data?.recents||[]).filter(r=>r.fingerprint!==fingerprint);
    if(JSON.stringify(others)!==JSON.stringify(original.slice(0,Math.min(19,original.length)))||!expectedLayout||JSON.stringify(current.data.layout)!==JSON.stringify(expectedLayout))throw Error('Concurrent state change detected; leaving the newer state untouched');
    if(before.state)await invoke('local_write',{kind,document,revision:current.revision,data:before.state.data});else await invoke('local_recover',{kind,document});
   }
  }catch(error){console.error('Could not restore '+kind+'; '+String(error));}
 }
 await stop();
}
