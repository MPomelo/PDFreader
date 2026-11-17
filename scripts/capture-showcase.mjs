// Documentation only: real app/PDF.js, original demo PDFs, mocked translation.
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import './workspace-fixtures.mjs';
const {chromium}=createRequire(import.meta.url)('playwright');
const server=spawn(process.execPath,[resolve('node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port','1432','--strictPort'],{windowsHide:true});
let browser;
try{
  for(let i=0;i<60;i++){try{if((await fetch('http://127.0.0.1:1432')).ok)break;}catch{}await new Promise(r=>setTimeout(r,150));}
  browser=await chromium.launch({executablePath:process.env.EDGE_EXECUTABLE||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:['--disable-crash-reporter']});
  const page=await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:1432/test-results/workspace/app.html');
  await page.locator('input[type=file]').setInputFiles([resolve('docs/assets/research-notes.pdf'),resolve('docs/assets/reading-workflow.pdf')]);
  await page.getByRole('tab',{name:'research-notes.pdf',exact:true}).click();
  const frame=page.frameLocator('.document-pane[data-active=true] iframe');
  await frame.locator('.textLayer span').first().waitFor({timeout:30000});
  await page.getByRole('combobox',{name:'缩放',exact:true}).selectOption('page-fit');
  await page.evaluate(()=>{window.responseText='## 跨领域学习\n\n领域适应将**有标签源域**的知识迁移到**无标签目标域**，学习在数据分布变化后仍然有效的表示。\n\n### 共享表示\n\n特征提取器编码图像，分类器预测标签，域判别器促使特征减少领域信息。\n\n$$\\mathcal{L}=\\mathcal{L}_{cls}-\\lambda\\mathcal{L}_{dom}$$\n\n| 模块 | 作用 |\n| --- | --- |\n| 特征提取器 | 学习共享表示 |\n| 分类器 | 预测类别 |\n| 域判别器 | 对齐域分布 |\n\n> 关注源域与目标域的关系，以及伪标签阈值对结果的影响。';});
  await frame.locator('.textLayer span').filter({hasText:'Domain adaptation transfers'}).first().evaluate(el=>{const range=document.createRange();range.selectNodeContents(el);getSelection().removeAllRanges();getSelection().addRange(range);});
  await frame.locator('body').press('Control+Shift+Enter');
  await page.locator('.tab-translation:not([hidden]) .stream-status').filter({hasText:'已完成'}).waitFor();
  assert.equal(await page.evaluate(()=>window.calls.length),1);
  await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:'docs/assets/workspace-light.png'});
  await page.getByRole('button',{name:'设置',exact:true}).click();
  await page.getByRole('button',{name:'翻译偏好',exact:true}).click();
  await page.screenshot({path:'docs/assets/settings.png'});
  await page.getByRole('button',{name:'阅读与外观',exact:true}).click();
  await page.getByLabel('界面主题',{exact:true}).selectOption('dark');
  await page.getByRole('button',{name:'关闭设置',exact:true}).click();
  await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:'docs/assets/workspace-dark.png'});
  assert.deepEqual(errors,[]);console.log('Three showcase screenshots captured; translation explicitly mocked; zero provider requests.');
}finally{await browser?.close();server.kill();}
