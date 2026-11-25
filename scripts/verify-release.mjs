// Actual NSIS installation and optional Windows Open-with association.
// No live translation calls, no API/key edits, no Windows default changes.
import {spawn,spawnSync,execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {readFileSync,writeFileSync,copyFileSync,mkdirSync,existsSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const {chromium}=createRequire(import.meta.url)('playwright');
const root=resolve('test-results/stage06');mkdirSync(root,{recursive:true});
const install=join(root,'安装 测试'),inputs=join(root,'中文 文件');mkdirSync(inputs,{recursive:true});
const a=join(inputs,'源域 文献.pdf'),b=join(inputs,'目标域 文献.pdf');
copyFileSync('docs/assets/research-notes.pdf',a);copyFileSync('docs/assets/reading-workflow.pdf',b);
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const originals=[hash(a),hash(b)];
const bundle=resolve('src-tauri/target/release/bundle/nsis');
const installer=join(bundle,readdirSync(bundle).find(n=>n.endsWith('-setup.exe')));
const ps=(command,env)=>execFileSync('powershell.exe',['-NoProfile','-Command',command],{encoding:'utf8',windowsHide:true,env:env||process.env}).trim();
function defaults(){return ps("$p='Registry::HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.pdf\\UserChoice';$c='Registry::HKEY_CURRENT_USER\\Software\\Classes\\.pdf';[pscustomobject]@{choice=if(Test-Path $p){(Get-ItemProperty -LiteralPath $p).ProgId}else{$null};pdfDefault=if(Test-Path $c){(Get-Item -LiteralPath $c).GetValue('')}else{$null}}|ConvertTo-Json -Compress");}
const defaultBefore=defaults();
const roaming=ps("[Environment]::GetFolderPath('ApplicationData')"),statePath=join(roaming,'local.pomelo.pdfreader','local-v1','state.json');
const snapshot=existsSync(statePath)?JSON.parse(readFileSync(statePath,'utf8')):null;
let browser,page,pid,expectedLayout;const evidence=[],errors=[],requests=[];
const env={...process.env,WEBVIEW2_USER_DATA_FOLDER:resolve('.local/release-native-qa'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=14711 --host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1"'};
const invoke=(command,args={})=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
const associated=pdf=>Number(execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',resolve('scripts/open-associated.ps1'),'-PdfPath',pdf],{encoding:'utf8',windowsHide:true,env}).trim());
async function installedRun(){return new Promise((done,reject)=>{const p=spawn(installer,['/S',`/D=${install}`],{windowsHide:true,windowsVerbatimArguments:true});p.on('error',reject);p.on('exit',code=>code===0?done():reject(Error('Installer exit '+code)));});}
try{
 await installedRun();assert.equal(defaults(),defaultBefore);
 const installedExe=join(install,'pdfreader.exe');assert.ok(existsSync(installedExe));const packaged=readFileSync(installedExe),standalone=readFileSync('src-tauri/target/release/pdfreader.exe');
 const marker=Buffer.from('__TAURI_BUNDLE_TYPE_VAR_');const pi=packaged.indexOf(marker)+marker.length,si=standalone.indexOf(marker)+marker.length;
 assert.ok(pi>=marker.length&&pi===si);assert.equal(packaged.subarray(pi,pi+3).toString(),'NSS');assert.equal(standalone.subarray(si,si+3).toString(),'UNK');
 const normalized=Buffer.from(packaged);standalone.copy(normalized,pi,si,si+3);assert.ok(normalized.equals(standalone),'Only the official NSIS bundle-type marker may differ');
 for(const file of ['LICENSE.txt','NOTICE.txt','licenses/PDFjs.txt','licenses/Runtime-JavaScript-Notices.txt','licenses/Runtime-Rust-Notices.txt'])assert.ok(existsSync(join(install,file)),file);
 evidence.push('Actual per-user NSIS installs into a Unicode/space directory, includes license files, and preserves .pdf default and UserChoice');
 pid=associated(a);assert.ok(pid>0);
 let version;for(let i=0;i<80;i++){try{version=await(await fetch('http://127.0.0.1:14711/json/version',{signal:AbortSignal.timeout(700)})).json();break;}catch{await new Promise(r=>setTimeout(r,200));}}assert.ok(version,'Installed app CDP');
 browser=await chromium.connectOverCDP(version.webSocketDebuggerUrl);page=browser.contexts()[0].pages()[0];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push(r.url()));
 await page.context().route(/^https?:\/\/(?!tauri\.localhost(?:[/:]|$)|ipc\.localhost(?:[/:]|$)|127\.0\.0\.1(?:[/:]|$)|localhost(?:[/:]|$))/,route=>route.abort());
 assert.match(page.url(),/^http:\/\/tauri\.localhost/);
 await page.getByRole('tab',{name:'源域 文献.pdf',exact:true}).waitFor({timeout:30000});
 const frame=()=>page.frameLocator('.document-pane[data-active=true] iframe');
 await frame().locator('.textLayer span').first().waitFor({timeout:30000});expectedLayout=(await invoke('local_read',{kind:'state',document:''})).data.layout;
 assert.ok((await frame().locator('.textLayer').innerText()).includes('Learning across domains'));
 await page.getByRole('combobox',{name:'缩放',exact:true}).selectOption('1.25');
 const firstView=await frame().locator('body').evaluate(()=>window.PDFViewerApplication.pdfDocument.fingerprints[0]);
 const secondPid=associated(b);assert.ok(secondPid>0);
 await page.getByRole('tab',{name:'目标域 文献.pdf',exact:true}).waitFor({timeout:15000});
 await page.getByRole('tab',{name:'源域 文献.pdf',exact:true}).click();
 assert.equal(await page.getByRole('combobox',{name:'缩放',exact:true}).inputValue(),'1.25');
 assert.equal(await frame().locator('body').evaluate(()=>window.PDFViewerApplication.pdfDocument.fingerprints[0]),firstView);
 // Repeated opens activate rather than duplicate the same path.
 associated(a);await page.waitForTimeout(600);assert.equal(await page.getByRole('tablist',{name:'PDF 文档'}).getByRole('tab').count(),2);
 evidence.push('Windows ShellExecute with installed optional PDFreader.PDF handler opens Unicode/space PDFs; repeated launches forward into existing tabs and preserve their state');
 await page.getByRole('button',{name:'查找',exact:true}).click();
 const find=page.getByRole('search',{name:'文档内查找'});
 await find.getByRole('searchbox').fill('Domain adaptation');await find.getByRole('status').filter({hasText:/[1-9] \/ [1-9]/}).waitFor();
 await find.getByRole('button',{name:'关闭查找'}).click();await find.waitFor({state:'hidden'});
 // Use the actual editor, not serialized annotation injection.
 await page.getByRole('combobox',{name:'缩放',exact:true}).selectOption('page-fit');
 await page.getByRole('button',{name:'批注工具',exact:true}).click();await page.getByRole('button',{name:'添加文本框',exact:true}).click();
 await frame().locator('.annotationEditorLayer').first().click({position:{x:110,y:430}});
 const editor=frame().locator('.freeTextEditor [contenteditable=true]').last();await editor.waitFor();await editor.fill('RELEASE_NATIVE_TEXT');await page.getByRole('button',{name:'批注工具',exact:true}).click();await page.getByRole('button',{name:'选择文字',exact:true}).click();await page.locator('.document-tab.selected .dirty-dot').waitFor();
 const exported=join(root,'安装版 批注-'+Date.now()+'.pdf');
 const save=new Promise((done,reject)=>{const helper=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',resolve('scripts/save-stage05-dialog.ps1'),'-AppProcessId',String(pid),'-TargetPath',exported],{windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';helper.stdout.on('data',b=>output+=b);helper.stderr.on('data',b=>output+=b);helper.on('exit',code=>code===0?done():reject(Error('Save dialog helper '+output)));});
 await Promise.all([page.getByRole('button',{name:'导出',exact:true}).click(),save]);
 await page.locator('.document-tab.selected .dirty-dot').waitFor({state:'detached'});assert.ok(existsSync(exported));
 evidence.push('Installed offline app loads embedded PDF.js/worker/fonts, searches real text, creates a text annotation through editor UI and exports via genuine Windows Save dialog');
 assert.deepEqual([hash(a),hash(b)],originals);assert.deepEqual(errors,[]);
 assert.ok(!requests.some(u=>/127\.0\.0\.1:14[23]\d/.test(u)),'No development server dependency');
 await page.screenshot({path:join(root,'installed-app.png')});expectedLayout=(await invoke('local_read',{kind:'state',document:''})).data.layout;
 writeFileSync(join(root,'installed-evidence.json'),JSON.stringify({installerSha256:hash(installer),exeSha256:hash(installedExe),evidence,errors,originalsUnchanged:true,defaultUnchanged:defaults()===defaultBefore,providerCalls:0,exported},null,2));
 console.log(JSON.stringify({passed:evidence.length,evidence,errors},null,2));
}catch(error){writeFileSync(join(root,'installed-failure.json'),JSON.stringify({error:String(error),errors,body:await page?.locator('body').innerText().catch(()=> '')},null,2));throw error;}
finally{
 if(page&&!page.isClosed())try{
  await page.waitForTimeout(800);const current=await invoke('local_read',{kind:'state',document:''});
  const own=new Set(originals),others=(current.data?.recents||[]).filter(r=>!own.has(r.fingerprint)),prior=(snapshot?.data?.recents||[]).filter(r=>!own.has(r.fingerprint));
  if(!expectedLayout||JSON.stringify(current.data.layout)!==JSON.stringify(expectedLayout)||JSON.stringify(others)!==JSON.stringify(prior.slice(0,Math.min(18,prior.length))))throw Error('Concurrent or incomplete state change; not restoring snapshot');
  if(snapshot)await invoke('local_write',{kind:'state',document:'',revision:current.revision,data:snapshot.data});
 }catch(error){console.warn(String(error));}
 if(page&&!page.isClosed())await invoke('finish_close').catch(()=>{});await browser?.close();
 const uninstall=join(install,'uninstall.exe');if(existsSync(uninstall)){spawnSync(uninstall,['/S'],{windowsHide:true,timeout:60000});for(let i=0;i<50&&existsSync(join(install,'pdfreader.exe'));i++)await new Promise(r=>setTimeout(r,100));}
 assert.equal(defaults(),defaultBefore,'Default association unchanged after uninstall');
 writeFileSync(join(root,'uninstall-evidence.json'),JSON.stringify({removedInstalledExe:!existsSync(join(install,'pdfreader.exe')),defaultUnchanged:true,handlerRemoved:ps("Test-Path 'Registry::HKEY_CURRENT_USER\\Software\\Classes\\PDFreader.PDF'")==='False'},null,2));
}
