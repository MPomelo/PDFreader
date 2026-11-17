import { useEffect, useRef, useState } from 'react';
import { Dismiss20Regular, Settings20Regular, Translate20Regular, PlugConnected20Regular, Database20Regular } from '@fluentui/react-icons';
import { TranslationPanel } from '../translation/TranslationPanel';
import { repository, exportNotes, type ReaderPreferences } from '../local/repository';
export type SettingsSection = 'general' | 'translation' | 'api' | 'data';
export function SettingsDialog({ open, initialSection, onClose, theme, onTheme, preferences, onPreferences, automatic, onAutomatic, documentKey }: { open: boolean; initialSection: SettingsSection; onClose: () => void; theme: 'light' | 'dark'; onTheme: (theme: 'light' | 'dark') => void; preferences: ReaderPreferences; onPreferences: (preferences: ReaderPreferences) => void; automatic: boolean; onAutomatic: (enabled: boolean) => void; documentKey: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [dirty, setDirty] = useState(false), [confirm, setConfirm] = useState(false), [notice, setNotice] = useState('');
  useEffect(() => { if (open) { setSection(initialSection); setConfirm(false); setDirty(false); setNotice(''); dialog.current?.showModal(); } else dialog.current?.close(); }, [open, initialSection]);
  function close() { if (dirty) setConfirm(true); else onClose(); }
  async function dataAction(action: () => Promise<unknown>, message: string) { try { const result = await action(); setNotice(result === null ? '已取消导出' : message); } catch (error) { setNotice(String(error)); } }
  const categories = [{ id: 'general', label: '阅读与外观', icon: <Settings20Regular /> }, { id: 'translation', label: '翻译偏好', icon: <Translate20Regular /> }, { id: 'api', label: 'API 服务', icon: <PlugConnected20Regular /> }, { id: 'data', label: '本地数据', icon: <Database20Regular /> }] as const;
  return <dialog ref={dialog} className="settings-dialog" aria-labelledby="settings-title" onCancel={event => { event.preventDefault(); close(); }}>
    <header className="settings-title"><h1 id="settings-title">设置</h1><button autoFocus aria-label="关闭设置" title="关闭设置" onClick={close}><Dismiss20Regular /></button></header>
    {open && <div className="settings-body"><nav className="settings-nav" aria-label="设置分类">{categories.map(category => <button key={category.id} aria-pressed={section === category.id} onClick={() => setSection(category.id)}>{category.icon}{category.label}</button>)}</nav>
      <div className="settings-content">
        {section === 'general' && <section><h2>阅读与外观</h2><label className="field">界面主题<select aria-label="界面主题" value={theme} onChange={event => onTheme(event.target.value as 'light' | 'dark')}><option value="light">浅色</option><option value="dark">深色</option></select></label>
          <label className="field">首次打开时的缩放<select aria-label="首次打开时的缩放" value={preferences.defaultZoom} onChange={event => onPreferences({ ...preferences, defaultZoom: event.target.value })}><option value="auto">自动</option><option value="page-width">适合页宽</option><option value="page-fit">适合页面</option><option value="1">100%</option><option value="1.25">125%</option><option value="1.5">150%</option><option value="2">200%</option></select></label>
          <label className="checkbox"><input type="checkbox" checked={preferences.restoreProgress} onChange={event => onPreferences({ ...preferences, restoreProgress: event.target.checked })} />恢复上次阅读进度</label>
          <label className="checkbox"><input type="checkbox" checked={preferences.selectionPopup} onChange={event => onPreferences({ ...preferences, selectionPopup: event.target.checked })} />选中文字时显示浮窗翻译入口</label>
          <label className="checkbox"><input type="checkbox" checked={preferences.showOriginal} onChange={event => onPreferences({ ...preferences, showOriginal: event.target.checked })} />译文中默认展开原文</label>
          <label className="checkbox"><input type="checkbox" checked={preferences.showMetadata} onChange={event => onPreferences({ ...preferences, showMetadata: event.target.checked })} />直接显示模型、耗时与用量</label><p className="muted">阅读与外观设置自动保存。</p>
        </section>}
        <div hidden={section !== 'translation' && section !== 'api'}><TranslationPanel mode="settings" settingsSection={section === 'api' ? 'api' : 'translation'} reader={null} visible settingsOpen onSettings={() => {}} onComment={() => {}} disabled={false} active={false} automatic={automatic} onAutomatic={onAutomatic} onDirtyChange={setDirty} /></div>
        {section === 'data' && <section><h2>本地数据</h2><p className="muted">缓存与笔记分开保存。清理缓存不会删除笔记。</p><div className="data-actions"><button disabled={!documentKey} onClick={() => { void dataAction(() => repository.clearCache(documentKey), '当前文档缓存已清理'); }}>清理当前文档缓存</button><button onClick={() => { void dataAction(() => exportNotes(repository.snapshot.notes), '笔记导出操作已完成'); }}>导出全部笔记</button></div><p className="muted">最近文件与笔记可在工具栏左侧“文档”中管理。</p></section>}
        {notice && <p className="settings-notice" role="status">{notice}</p>}
      </div>
    </div>}
    {confirm && <div className="settings-confirm" role="alert"><p>翻译或 API 设置尚未保存。</p><button onClick={() => setConfirm(false)}>继续编辑</button><button onClick={() => { setDirty(false); onClose(); }}>放弃未保存设置并关闭</button></div>}
  </dialog>;
}
