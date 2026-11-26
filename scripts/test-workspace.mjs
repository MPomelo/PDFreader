import {test} from 'node:test';import assert from 'node:assert/strict';
import {adjacentTabId,shortcutTabId} from '../src/reader/tabs.ts';
import {defaultWorkspace,move,singleTranslation} from '../src/workspace/layout.ts';
import {build} from 'esbuild';import {pathToFileURL} from 'node:url';import {resolve} from 'node:path';
await build({entryPoints:['src/local/repository.ts'],outfile:'.local/workspace-repository.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});
const {LocalRepository,DEFAULT_READER_PREFERENCES,validate}=await import(pathToFileURL(resolve('.local/workspace-repository.mjs')));
test('closing a background document keeps the active tab and closing active chooses the right then left neighbor',()=>{assert.equal(adjacentTabId(['a','b','c'],'a','c'),'c');assert.equal(adjacentTabId(['a','b','c'],'b','b'),'c');assert.equal(adjacentTabId(['a','b','c'],'c','c'),'b');assert.equal(adjacentTabId(['a'],'a','a'),'');});
test('browser-style tab shortcuts wrap in both directions and Ctrl+9 selects the last document',()=>{assert.equal(shortcutTabId(['a','b','c'],'c','Tab'),'a');assert.equal(shortcutTabId(['a','b','c'],'a','Tab',true),'c');assert.equal(shortcutTabId(['a','b','c'],'a','2'),'b');assert.equal(shortcutTabId(['a','b','c'],'a','9'),'c');assert.equal(shortcutTabId([],'','Tab'),'');});
test('old version-one reading state remains readable and preference writes do not overwrite recents/layout',async()=>{const layout={left:true,right:false,reading:false,floating:false,leftWidth:220,rightWidth:340,theme:'light'};let record={version:1,revision:5,data:{version:1,layout,recents:[{fingerprint:'a'.repeat(64),name:'a.pdf',path:'a.pdf',page:2,zoom:'auto',time:'now'}]}};const repo=new LocalRepository({read:async kind=>kind==='state'?structuredClone(record):{version:1,revision:0,data:null},write:async(kind,document,revision,data)=>{assert.equal(revision,record.revision);record={version:1,revision:revision+1,data};return structuredClone(record);},recover:async()=>''});await repo.init();const preferences={...DEFAULT_READER_PREFERENCES,defaultZoom:'page-width',showMetadata:true};await repo.savePreferences(preferences);assert.deepEqual(record.data.layout,layout);assert.equal(record.data.recents[0].page,2);assert.deepEqual(record.data.preferences,preferences);assert.throws(()=>validate('state',{...record.data,preferences:{...preferences,defaultZoom:'invalid'}}));});

test('older layouts keep the focused translation and fill the vacated tab selection', () => {
  const resources = [
    { id: 'old', kind: 'translation', name: '译文', source: 'upper' },
    { id: 'note', kind: 'markdown', name: '笔记.md', path: '笔记.md' },
    { id: 'focused', kind: 'translation', name: '译文', source: 'lower' },
  ];
  let layout = move(defaultWorkspace(), 'note', 'lower');
  layout = move(layout, 'old', 'lower');
  layout = move(layout, 'focused', 'right');
  const restored = singleTranslation({ ...layout, version: 1, resources });
  assert.deepEqual(restored.resources, resources.slice(1));
  assert.deepEqual(restored.order.lower, ['note']);
  assert.equal(restored.selected.lower, 'note');
  assert.equal(restored.selected.right, 'focused');
  assert.equal(restored.focus, 'right');
});

test('older preferences gain the default interface size and preserve their translation size', () => {
  const { uiFontSize, ...older } = DEFAULT_READER_PREFERENCES;
  const layout = { left: false, right: false, reading: false, floating: false, leftWidth: 220, rightWidth: 340, theme: 'light' };
  const migrated = validate('state', { version: 1, layout, recents: [], preferences: { ...older, translationFontSize: 18 } });
  assert.equal(migrated.preferences.uiFontSize, uiFontSize);
  assert.equal(migrated.preferences.translationFontSize, 18);
});

test('legacy chat settings retain their model and history and acquire local settings and commands', () => {
  const preferences = { provider: 'anthropic', models: { openai: 'gpt', anthropic: 'claude' }, prompt: 'zh' };
  const conversations = [{ id: 'chat-1', updated: 'now', turns: [{
    id: 'turn-1', prompt: 'Short question', materials: [], provider: 'anthropic', model: 'claude', text: 'Reply', state: 'complete',
  }] }];
  const migrated = validate('chat', { version: 1, preferences, conversations });
  assert.equal(migrated.preferences.provider, preferences.provider);
  assert.equal(migrated.preferences.models.anthropic, preferences.models.anthropic);
  assert.equal(migrated.preferences.ollamaPort, 11434);
  assert.equal(migrated.preferences.sendShortcut, 'enter');
  assert.ok(migrated.preferences.commands.some(command => command.name === '总结'));
  assert.deepEqual(migrated.conversations, conversations);
});
