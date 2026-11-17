import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {answer} from './stage04-fixtures.mjs';
mkdirSync('test-results/workspace',{recursive:true});
writeFileSync('test-results/workspace/second.pdf',Buffer.concat([readFileSync('test-results/stage02/reading.pdf'),Buffer.from('\n% independent second PDF\n')]));
writeFileSync('test-results/workspace/identical.pdf',readFileSync('test-results/stage02/reading.pdf'));
writeFileSync('test-results/workspace/app.html','<!doctype html><html lang="zh"><meta charset="utf-8"><div id="root"></div><script type="module" src="/test-results/workspace/app.ts"></script></html>');
const config={version:1,activeId:'fixture',profiles:[{id:'fixture',name:'测试服务',provider:'custom',baseUrl:'https://example.com/v1',model:'fixture-model',auth:'none'}],targetLanguage:'简体中文',prompt:'忠实翻译',glossary:'',maxTokens:4096,timeoutSeconds:60,streaming:true,answerStyle:'concise'};
writeFileSync('test-results/workspace/app.ts',`
import {api} from '/src/translation/client.ts';
let config=JSON.parse(localStorage.getItem('workspace-fixture-config')||'null')||${JSON.stringify(config)};
window.calls=[];window.cancelled=[];window.responseText=${JSON.stringify(answer)};window.delay=1;window.ignoreCancel=false;
api.desktop=()=>true;api.load=async()=>structuredClone(config);api.save=async next=>{config=structuredClone(next);localStorage.setItem('workspace-fixture-config',JSON.stringify(config));};api.status=async()=>({available:true,mode:'session'});
api.cancel=async id=>{window.cancelled.push(id);};
api.stream=async(request,onChunk)=>{window.calls.push({...request});const text=window.responseText,delay=window.delay,ignore=window.ignoreCancel;let seq=0;
 for(let i=0;i<text.length;i+=64){await new Promise(r=>setTimeout(r,delay));if(window.cancelled.includes(request.requestId)&&!ignore)throw Error('已取消');onChunk({requestId:request.requestId,documentId:request.documentId,seq:++seq,content:text.slice(i,i+64),reasoning:''});}
 return {requestId:request.requestId,documentId:request.documentId,text,reasoning:'',model:config.profiles[0].model,elapsedMs:200,usage:{total_tokens:80},models:[]};};
api.request=async request=>{window.calls.push({...request});return {requestId:request.requestId,documentId:request.documentId,text:window.responseText,reasoning:'',model:config.profiles[0].model,elapsedMs:200,usage:null,models:[]};};
await import('/src/main.tsx');
`);
