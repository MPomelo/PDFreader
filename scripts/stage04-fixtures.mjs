import { mkdirSync, writeFileSync } from 'node:fs';
export const answer = String.raw`## 学术译文

特征向量为 $\mathbf{z}=f_{\theta}(x)\in\mathbb{R}^{d}$，域判别器通过对抗训练缩小分布差异。

$$
\mathcal{L}=\frac{1}{N}\sum_{i=1}^{N}\mathcal{L}_{y}(\hat y_i,y_i)-\lambda\mathcal{L}_{d}(\hat d_i,d_i)
$$

### 模块与指标

| 模块 | 作用 | 示例 |
| --- | --- | --- |
| 特征提取 | 学习共享表示 | $f_{\theta}(x)$ |
| 分类器 | 预测类别 | $\hat{y}$ |
| 域判别器 | 区分源域和目标域 | $\mathcal{L}_d$ |

- 保留引用编号 **[1]** 与希腊字母 $\alpha,\beta,\lambda$。
- 代码中的 CODE_COST 和金额 $5、$10 应保持原样。

$$
\begin{aligned}
\mathbf{A}&=\begin{bmatrix}1&2\\3&4\end{bmatrix}\\
\mathbf{z}'&=\mathbf{A}\mathbf{z}
\end{aligned}
$$

> 原 PDF 中已经损坏的公式需要对照原页核实。
`.replace('CODE_COST', String.fromCharCode(96) + '$cost' + String.fromCharCode(96));
const config = { version: 1, activeId: 'fixture', profiles: [{ id: 'fixture', name: '本地模拟服务', provider: 'custom', baseUrl: 'https://example.com/v1', model: 'fixture-model', auth: 'none' }], targetLanguage: '简体中文', prompt: '忠实翻译', glossary: '', maxTokens: 4096, timeoutSeconds: 60, streaming: true, answerStyle: 'concise' };
mkdirSync('test-results/stage04', { recursive: true });
writeFileSync('test-results/stage04/app.html', '<!doctype html><html lang="zh"><meta charset="utf-8"><div id="root"></div><script type="module" src="/test-results/stage04/app.ts"></script></html>');
writeFileSync('test-results/stage04/app.ts', `
import { api } from '/src/translation/client.ts';
let config = ${JSON.stringify(config)};
const answer = ${JSON.stringify(answer)};
const cancelled = new Set();
window.fixtureCalls = []; window.fixtureDelay = 60; window.fixtureIgnoreCancel = false;
api.desktop = () => true;
api.load = async () => structuredClone(config);
api.save = async next => { config = structuredClone(next); };
api.status = async () => ({available:true,mode:'session'});
api.request = async request => {
  window.fixtureCalls.push({...request,stream:false});
  return {requestId:request.requestId,documentId:request.documentId,text:request.kind==='test'?'天空是蓝色的。':answer,model:'fixture-model',elapsedMs:80,usage:{total_tokens:80},models:['fixture-model'],reasoning:''};
};
api.cancel = async id => { cancelled.add(id); };
api.stream = async (request,onChunk) => {
  const delay=window.fixtureDelay, ignore=window.fixtureIgnoreCancel;
  window.fixtureCalls.push({...request,stream:true}); let seq=0;
  onChunk({requestId:request.requestId,documentId:request.documentId,seq:++seq,content:'',reasoning:'模拟思考内容，与译文分开。'});
  const text=request.kind==='test'?'天空是蓝色的。':answer;
  for(let i=0;i<text.length;i+=28) {
    await new Promise(resolve=>setTimeout(resolve,delay));
    if(cancelled.has(request.requestId)&&!ignore)throw Error('模拟请求已取消');
    onChunk({requestId:request.requestId,documentId:request.documentId,seq:++seq,content:text.slice(i,i+28),reasoning:''});
  }
  return {requestId:request.requestId,documentId:request.documentId,text,model:'fixture-model',elapsedMs:500,usage:{total_tokens:80},models:[],reasoning:'模拟思考内容，与译文分开。'};
};
await import('/src/main.tsx');
`);
writeFileSync('test-results/stage04/renderer.html', '<!doctype html><html lang="zh"><meta charset="utf-8"><div id="root"></div><script type="module" src="/test-results/stage04/renderer.tsx"></script></html>');
writeFileSync('test-results/stage04/renderer.tsx', `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {MarkdownRenderer} from '/src/translation/MarkdownRenderer.tsx';
import '/src/ui/styles.css';
const source=${JSON.stringify(answer + '\n\n局部坏公式 $\\frac{1}{$，其他内容继续显示。')};
createRoot(document.getElementById('root')).render(<main style={{display:'block',width:580,margin:'24px auto',padding:24,background:'white'}}><MarkdownRenderer source={source}/></main>);
`);
