import { spawn, execFile, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const { chromium }=createRequire(import.meta.url)('playwright');
const roaming=execFileSync('powershell.exe',['-NoProfile','-Command',"[Environment]::GetFolderPath('ApplicationData')"],{windowsHide:true,encoding:'utf8'}).trim();
const statePath=join(roaming,'local.pomelo.pdfreader','local-v1','state.json');
const original=existsSync(statePath)?JSON.parse(readFileSync(statePath,'utf8')):null;
const fingerprint=createHash('sha256').update(readFileSync('test-results/stage02/reading.pdf')).digest('hex');
const missing=resolve('test-results/stage05','missing-'+Date.now()+'.pdf');assert.equal(existsSync(missing),false);
let app,browser,page,layout,port=14690;const evidence=[],errors=[];
async function launch(args){app=spawn(resolve('src-tauri/target/release/pdfreader.exe'),args,{windowsHide:true,env:{...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port++}`,WEBVIEW2_USER_DATA_FOLDER:resolve('.local/stage05-paths-qa')}});let version;for(let i=0;i<60;i++){try{version=await(await fetch(`http://127.0.0.1:${port-1}/json/version`,{signal:AbortSignal.timeout(1000)})).json();break;}catch{await new Promise(r=>setTimeout(r,200));}}assert.ok(version);browser=await chromium.connectOverCDP(version.webSocketDebuggerUrl);page=browser.contexts()[0].pages()[0];page.on('pageerror',error=>errors.push(error.message));await page.locator('.app').waitFor();}
const invoke=(command,args={})=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
async function stop(){if(page&&!page.isClosed()){try{await invoke('finish_close');}catch{}}if(browser){try{await browser.close();}catch{}}if(app?.exitCode==null)app?.kill();page=browser=null;}
async function chooseFile(path){await new Promise((done,reject)=>execFile('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',resolve('scripts/save-stage05-dialog.ps1'),'-AppProcessId',String(app.pid),'-TargetPath',resolve(path)],{windowsHide:true,timeout:20000},(error,stdout,stderr)=>error?reject(Error(String(error)+' '+stderr)):done(stdout)));}
try{
 await launch([resolve('test-results/stage02/reading.pdf')]);await page.frameLocator('iframe').locator('.textLayer span').first().waitFor();await page.waitForTimeout(1000);
 const record=await invoke('local_read',{kind:'state',document:''});layout={...record.data.layout,left:true,right:false,reading:false,floating:false,theme:'light'};
 await invoke('local_write',{kind:'state',document:'',revision:record.revision,data:{version:1,layout,recents:[{fingerprint,name:'stage05-missing.pdf',path:missing,page:2,zoom:'page-width',time:new Date().toISOString()},...record.data.recents.filter(r=>r.fingerprint!==fingerprint).slice(0,19)]}});
 await stop();await launch([]);await page.getByRole('alert').filter({hasText:'文件已移动或不存在'}).waitFor();await page.getByRole('tab',{name:'最近',exact:true}).click();
 const entry=page.locator('.library-item').filter({has:page.getByRole('button',{name:'stage05-missing.pdf',exact:true})});await entry.waitFor();
 evidence.push('Native restart with an absent recent file leaves the missing record visible and reports relocation/removal instead of discarding progress');
 await Promise.all([entry.getByRole('button',{name:'重新定位',exact:true}).click(),chooseFile('test-results/stage02/scanned.pdf')]);await page.getByRole('alert').filter({hasText:'所选文件内容不匹配'}).waitFor();
 assert.equal((await invoke('local_read',{kind:'state',document:''})).data.recents.find(r=>r.fingerprint===fingerprint).path,missing);
 evidence.push('The real Windows Open dialog rejects a different PDF during relocation and preserves the old record');
 await Promise.all([entry.getByRole('button',{name:'重新定位',exact:true}).click(),chooseFile('test-results/stage02/reading.pdf')]);const frame=page.frameLocator('iframe');await frame.locator('.page[data-page-number="2"] .textLayer span').first().waitFor();assert.equal(await frame.locator('#pageNumber').inputValue(),'2');assert.equal(await frame.locator('#scaleSelect').inputValue(),'page-width');await page.waitForTimeout(1000);
 const relocated=(await invoke('local_read',{kind:'state',document:''})).data.recents.find(r=>r.fingerprint===fingerprint);assert.notEqual(relocated.path,missing);assert.equal(relocated.page,2);
 await page.screenshot({path:'test-results/stage05/native-relocated.png'});
 const opened=page.locator('.library-item').filter({has:page.getByRole('button',{name:'reading.pdf',exact:true})});await opened.getByRole('button',{name:'移除记录',exact:true}).click();await opened.waitFor({state:'detached'});assert.ok(!(await invoke('local_read',{kind:'state',document:''})).data.recents.some(r=>r.fingerprint===fingerprint));
 evidence.push('Selecting the identical PDF restores page 2/zoom and repairs its path; removing the recent record works independently');
 assert.deepEqual(errors,[]);writeFileSync('test-results/stage05/native-path-evidence.json',JSON.stringify({exeSha256:createHash('sha256').update(readFileSync('src-tauri/target/release/pdfreader.exe')).digest('hex').toUpperCase(),environment:'final production EXE, real Windows Open dialog, real native content hash and persistent recent-file state; no provider requests',evidence,errors},null,2));console.log(JSON.stringify({passed:evidence.length,evidence,errors},null,2));
}catch(error){writeFileSync('test-results/stage05/native-path-failure.json',JSON.stringify({error:String(error),errors,body:await page?.locator('body').innerText().catch(()=> '')},null,2));throw error;}
finally{
 if(page&&!page.isClosed())try{await page.waitForTimeout(1000);const now=await invoke('local_read',{kind:'state',document:''});const others=(now.data?.recents||[]).filter(r=>r.fingerprint!==fingerprint),before=(original?.data?.recents||[]).filter(r=>r.fingerprint!==fingerprint);
  if(JSON.stringify(others)!==JSON.stringify(before.slice(0,Math.min(19,before.length)))||!layout||JSON.stringify(now.data.layout)!==JSON.stringify(layout))throw Error('Concurrent state change; no cleanup overwrite');
  if(original)await invoke('local_write',{kind:'state',document:'',revision:now.revision,data:original.data});else await invoke('local_recover',{kind:'state',document:''});
 }catch(error){console.error(String(error));}
 await stop();
}
