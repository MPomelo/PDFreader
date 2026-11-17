import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
await build({ entryPoints:['src/local/repository.ts'],outfile:'.local/stage05-repository.mjs',bundle:true,platform:'node',format:'esm',packages:'external' });
const {LocalRepository,cacheKey,notesMarkdown,validate}=await import(pathToFileURL(resolve('.local/stage05-repository.mjs')));
const fingerprint='a'.repeat(64), other='b'.repeat(64);
const config={version:1,activeId:'p',profiles:[],targetLanguage:'中文',prompt:'academic',glossary:'domain=域',maxTokens:4096,timeoutSeconds:60,answerStyle:'concise',streaming:true};
const profile={id:'p',name:'test',provider:'custom',baseUrl:'https://example.com/v1',model:'m',auth:'bearer'};
const response={requestId:'r',documentId:'d',text:String.raw`译文 $\frac{a}{b}$`,model:'m',elapsedMs:100,usage:null,models:[],reasoning:'separate thought'};
function backend(){const records=new Map();return {records,async read(k,d){return structuredClone(records.get(k+d)||{version:1,revision:0,data:null});},async write(k,d,r,data){const now=await this.read(k,d);if(now.revision!==r)throw Error('conflict');const next={version:1,revision:r+1,data:structuredClone(data)};records.set(k+d,next);return next;},async recover(k,d){records.set(k+d+'.backup',records.get(k+d));records.delete(k+d);return 'backup';}};}
const note=(id='n')=>({id,fingerprint,name:'论文.pdf',page:2,original:'source',originalRaw:'raw\nsource',markdown:response.text,model:'m',service:'test',domain:'academic',language:'中文',time:'2026-11-16T12:00:00Z'});
test('cache identity isolates document, selection location and every request-affecting setting without a key',async()=>{
 const key=await cacheKey(fingerprint,'source',[{page:1}],config,profile);
 const variants=[await cacheKey(other,'source',[{page:1}],config,profile),await cacheKey(fingerprint,'changed',[{page:1}],config,profile),await cacheKey(fingerprint,'source',[{page:2}],config,profile)];
 for(const [field,value] of Object.entries({targetLanguage:'English',prompt:'general',glossary:'new',answerStyle:'detailed',maxTokens:8000,streaming:false}))variants.push(await cacheKey(fingerprint,'source',[{page:1}],{...config,[field]:value},profile));
 for(const [field,value] of Object.entries({provider:'mimo',baseUrl:'https://elsewhere.com/v1',model:'new',auth:'none',id:'another'}))variants.push(await cacheKey(fingerprint,'source',[{page:1}],config,{...profile,[field]:value}));
 assert.equal(new Set([key,...variants]).size,variants.length+1);assert.match(key,/^[a-f0-9]{64}$/);
 const anchor='[[1,0,0],[1,0,30]]';
 assert.equal(await cacheKey(fingerprint,'source',[{x:0.123}],config,profile,anchor),await cacheKey(fingerprint,'source',[{x:0.124}],config,profile,anchor));
 assert.notEqual(await cacheKey(fingerprint,'source',[],config,profile,anchor),await cacheKey(fingerprint,'source',[],config,profile,'[[2,0,0],[2,0,30]]'));
});
test('notes and cache reopen separately, raw Markdown is retained and clearing cache cannot delete notes',async()=>{
 const db=backend(), repo=new LocalRepository(db);await repo.init();await repo.saveNote(note());await repo.cache(fingerprint,'1'.repeat(64),response);
 const reopened=new LocalRepository(db);await reopened.init();assert.equal(reopened.snapshot.notes[0].markdown,response.text);assert.equal((await reopened.cached(fingerprint,'1'.repeat(64))).reasoning,'');
 await reopened.clearCache(fingerprint);assert.equal(await reopened.cached(fingerprint,'1'.repeat(64)),null);assert.equal(reopened.snapshot.notes.length,1);
 const markdown=notesMarkdown(reopened.snapshot.notes);assert.ok(markdown.includes(response.text));assert.ok(markdown.includes('raw\nsource'));assert.ok(!markdown.includes(response.reasoning));
});
test('cache capacity, recents capacity, content identity and moved path mapping are bounded',async()=>{
 const db=backend(),repo=new LocalRepository(db);await repo.init();
 for(let i=0;i<44;i++)await repo.cache(fingerprint,i.toString(16).padStart(64,'0'),response);
 assert.equal(db.records.get('cache'+fingerprint).data.entries.length,40);assert.equal(await repo.cached(fingerprint,'0'.repeat(64)),null);
 await repo.cache(fingerprint,'e'.repeat(64),{...response,text:'译'.repeat(180000)});await repo.cache(fingerprint,'f'.repeat(64),{...response,text:'文'.repeat(180000)});
 assert.ok(new TextEncoder().encode(JSON.stringify(db.records.get('cache'+fingerprint).data.entries)).byteLength<=750*1024);
 const retained=structuredClone(db.records.get('cache'+fingerprint).data.entries);
 await repo.cache(fingerprint,'d'.repeat(64),{...response,text:'大'.repeat(190000)+'字'.repeat(80000)});assert.deepEqual(db.records.get('cache'+fingerprint).data.entries,retained);
 for(let i=0;i<24;i++)await repo.progress({fingerprint:i.toString(16).padStart(64,'0'),name:'x.pdf',path:'p'+i,page:2,zoom:'page-width',time:'now'});
 assert.equal(repo.snapshot.book.recents.length,20);
 await repo.progress({fingerprint:other,name:'moved.pdf',path:'new',page:3,zoom:'auto',time:'now'});
 await repo.progress({fingerprint:other,name:'moved.pdf',path:'relocated',page:3,zoom:'auto',time:'now'});assert.equal(repo.snapshot.book.recents.filter(r=>r.fingerprint===other).length,1);
});
test('corruption and future schemas stay read-only until explicit backup recovery',async()=>{
 const db=backend();db.records.set('notes',{version:1,revision:4,data:{version:99,notes:[]}});const repo=new LocalRepository(db);await repo.init();assert.equal(repo.snapshot.problems.length,1);
 await assert.rejects(repo.saveNote(note()));assert.equal(db.records.get('notes').data.version,99);
 await repo.recover(repo.snapshot.problems[0]);assert.equal(db.records.get('notes.backup').revision,4);await repo.saveNote(note());assert.equal(repo.snapshot.notes.length,1);
 assert.throws(()=>validate('state',{version:1,layout:{},recents:[]}));
});
test('queued writes preserve independent updates and concurrent windows reject lost updates',async()=>{
 const db=backend(),repo=new LocalRepository(db);await repo.init();await Promise.all([repo.saveNote(note('1')),repo.saveNote({...note('2'),original:'second'})]);assert.equal(repo.snapshot.notes.length,2);
 const second=new LocalRepository(db);await second.init();await repo.saveNote({...note('3'),original:'third'});await assert.rejects(second.deleteNote('1'),/conflict/);assert.equal(db.records.get('notes').data.notes.length,3);
});
