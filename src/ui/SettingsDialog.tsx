import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowSync20Regular, Chat20Regular, Dismiss20Regular, Settings20Regular, Translate20Regular, PlugConnected20Regular, Database20Regular } from '@fluentui/react-icons';
import { TranslationSettings, type TranslationDirtyState } from '../translation/TranslationSettings';
import { repository, exportNotes, UI_FONT_SIZES, TRANSLATION_FONT_SIZES, type ReaderPreferences } from '../local/repository';
import { ChatSettings } from '../chat/ChatSettings';
import { ACCENTS, type Accent, type ThemeMode } from './appearance';
import { UpdatePanel } from './UpdatePanel';

export type SettingsSection = 'general' | 'translation' | 'api' | 'data' | 'chat' | 'chatgpt' | 'chat-api' | 'update';

type DirtySection = 'translation' | 'api' | 'chat' | 'chat-api';
type DirtySections = Record<DirtySection, boolean>;
type PendingAction = { type: 'close' } | { type: 'switch'; target: SettingsSection } | null;

const EMPTY_DIRTY: DirtySections = { translation: false, api: false, chat: false, 'chat-api': false };
const DIRTY_LABELS: Record<DirtySection, string> = {
  translation: '翻译偏好',
  api: '翻译配置',
  chat: 'AI设置',
  'chat-api': 'AI 兼容 API',
};

function isTranslationGroup(value: SettingsSection) {
  return value === 'translation' || value === 'api';
}

function isChatGroup(value: SettingsSection) {
  return value === 'chat' || value === 'chatgpt' || value === 'chat-api';
}

export function SettingsDialog({
  open, initialSection, onClose, theme, onTheme, accent, onAccent, preferences, onPreferences,
  automatic, onAutomatic, documentKey, onClearChat, onInstallUpdate, installUpdateDisabled,
}: {
  open: boolean;
  initialSection: SettingsSection;
  onClose: () => void;
  theme: ThemeMode;
  onTheme: (theme: ThemeMode) => void;
  accent: Accent;
  onAccent: (accent: Accent) => void;
  preferences: ReaderPreferences;
  onPreferences: (preferences: ReaderPreferences) => void;
  automatic: boolean;
  onAutomatic: (enabled: boolean) => void;
  documentKey: string;
  onClearChat: () => void;
  onInstallUpdate: () => Promise<string | void>;
  installUpdateDisabled: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [dirtySections, setDirtySections] = useState<DirtySections>(EMPTY_DIRTY);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [translationResetKey, setTranslationResetKey] = useState(0);
  const [notice, setNotice] = useState('');

  const dirtyList = (Object.keys(DIRTY_LABELS) as DirtySection[]).filter(key => dirtySections[key]);
  const hasDirty = dirtyList.length > 0;
  const dirtySummary = dirtyList.map(key => DIRTY_LABELS[key]).join('、');

  useEffect(() => {
    if (open) {
      setSection(initialSection);
      setPendingAction(null);
      setDirtySections(EMPTY_DIRTY);
      setNotice('');
      dialog.current?.showModal();
    } else {
      dialog.current?.close();
    }
  }, [open, initialSection]);

  useEffect(() => {
    if (open && content.current) content.current.scrollTop = 0;
  }, [open, section]);

  useEffect(() => {
    if (!hasDirty) setPendingAction(null);
  }, [hasDirty]);

  const handleTranslationDirty = useCallback((state: TranslationDirtyState) => {
    setDirtySections(previous => (
      previous.translation === state.translation && previous.api === state.api
        ? previous
        : { ...previous, translation: state.translation, api: state.api }
    ));
  }, []);

  const handleChatDirty = useCallback((dirty: boolean) => {
    setDirtySections(previous => (previous.chat === dirty ? previous : { ...previous, chat: dirty }));
  }, []);

  const handleChatApiDirty = useCallback((dirty: boolean) => {
    setDirtySections(previous => (previous['chat-api'] === dirty ? previous : { ...previous, 'chat-api': dirty }));
  }, []);

  function requestClose() {
    if (hasDirty) setPendingAction({ type: 'close' });
    else onClose();
  }

  function requestSection(target: SettingsSection) {
    if (target === section || (isChatGroup(section) && isChatGroup(target))) {
      setPendingAction(null);
      return;
    }
    // 翻译偏好与翻译配置共享同一份表单状态，组内切换保留草稿
    if (isTranslationGroup(section) && isTranslationGroup(target)) {
      setPendingAction(null);
      setSection(target);
      return;
    }
    if (hasDirty) {
      setPendingAction({ type: 'switch', target });
      return;
    }
    setSection(target);
  }

  function confirmDiscard() {
    if (!pendingAction) return;
    const action = pendingAction;
    if (dirtySections.translation || dirtySections.api) {
      setTranslationResetKey(value => value + 1);
    }
    setDirtySections(EMPTY_DIRTY);
    setPendingAction(null);
    if (action.type === 'close') onClose();
    else setSection(action.target);
  }

  async function dataAction(action: () => Promise<unknown>, message: string) {
    try {
      const result = await action();
      setNotice(result === null ? '已取消导出' : message);
    } catch (error) {
      setNotice(String(error));
    }
  }

  const categories = [
    { id: 'general', label: '阅读与外观', icon: <Settings20Regular /> },
    { id: 'translation', label: '翻译偏好', icon: <Translate20Regular /> },
    { id: 'api', label: '翻译配置', icon: <PlugConnected20Regular /> },
    { id: 'chat', label: 'AI设置', icon: <Chat20Regular /> },
    { id: 'data', label: '本地数据', icon: <Database20Regular /> },
    { id: 'update', label: '应用更新', icon: <ArrowSync20Regular /> },
  ] as const;

  const chatSection = isChatGroup(section);

  return <dialog ref={dialog} className="settings-dialog" aria-labelledby="settings-title" onCancel={event => { event.preventDefault(); requestClose(); }}>
    <header className="settings-title">
      <h1 id="settings-title">设置</h1>
      <button type="button" autoFocus aria-label="关闭设置" title="关闭设置" onClick={requestClose}><Dismiss20Regular /></button>
    </header>
    {open && <div className="settings-body">
      <nav className="settings-nav" aria-label="设置分类">
        {categories.map(category => (
          <button
            type="button"
            key={category.id}
            aria-pressed={section === category.id || (chatSection && category.id === 'chat')}
            onClick={() => requestSection(category.id)}
          >
            {category.icon}{category.label}
          </button>
        ))}
      </nav>
      <div className="settings-content" ref={content}>
        {section === 'general' && <section>
          <h2>阅读与外观</h2>
          <label className="field">界面主题
            <select aria-label="界面主题" value={theme} onChange={event => onTheme(event.target.value as ThemeMode)}>
              <option value="system">跟随系统</option>
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </select>
          </label>
          <fieldset className="accent-picker"><legend>主题色</legend>
            {(Object.keys(ACCENTS) as Accent[]).map(color => (
              <label key={color}>
                <input type="radio" name="accent" checked={accent === color} onChange={() => onAccent(color)} />
                <span className="accent-swatch" data-accent={color} aria-hidden="true" />{ACCENTS[color]}
              </label>
            ))}
          </fieldset>
          <div className="compact-fields">
            <label className="field">界面字号
              <select aria-label="界面字号" value={preferences.uiFontSize} onChange={event => onPreferences({ ...preferences, uiFontSize: Number(event.target.value) })}>
                {UI_FONT_SIZES.map(size => <option key={size} value={size}>{size} px</option>)}
              </select>
            </label>
            <label className="field">译文字号
              <select aria-label="译文字号" value={preferences.translationFontSize} onChange={event => onPreferences({ ...preferences, translationFontSize: Number(event.target.value) })}>
                {TRANSLATION_FONT_SIZES.map(size => <option key={size} value={size}>{size} px</option>)}
              </select>
            </label>
          </div>
          <label className="field">首次打开时的缩放
            <select aria-label="首次打开时的缩放" value={preferences.defaultZoom} onChange={event => onPreferences({ ...preferences, defaultZoom: event.target.value })}>
              <option value="auto">自动</option>
              <option value="page-width">适合页宽</option>
              <option value="page-fit">适合页面</option>
              <option value="1">100%</option>
              <option value="1.25">125%</option>
              <option value="1.5">150%</option>
              <option value="2">200%</option>
            </select>
          </label>
          <label className="checkbox"><input type="checkbox" checked={preferences.restoreProgress} onChange={event => onPreferences({ ...preferences, restoreProgress: event.target.checked })} />恢复上次阅读进度</label>
          <label className="checkbox"><input type="checkbox" checked={preferences.selectionPopup} onChange={event => onPreferences({ ...preferences, selectionPopup: event.target.checked })} />拖选结束后显示操作栏</label>
          <label className="checkbox"><input type="checkbox" checked={preferences.showOriginal} onChange={event => onPreferences({ ...preferences, showOriginal: event.target.checked })} />译文中默认展开原文</label>
          <label className="checkbox"><input type="checkbox" checked={preferences.showMetadata} onChange={event => onPreferences({ ...preferences, showMetadata: event.target.checked })} />直接显示模型、耗时与用量</label>
          <p className="muted">阅读与外观设置自动保存。</p>
        </section>}
        <div hidden={!isTranslationGroup(section)}>
          <TranslationSettings
            key={translationResetKey}
            section={section === 'api' ? 'api' : 'translation'}
            automatic={automatic}
            onAutomatic={onAutomatic}
            onDirtyChange={handleTranslationDirty}
          />
        </div>
        {chatSection && <ChatSettings
          key={section}
          onClear={onClearChat}
          initialProvider={section === 'chatgpt' ? 'chatgpt' : section === 'chat-api' ? 'compatible' : undefined}
          onDirtyChange={handleChatDirty}
          onApiDirtyChange={handleChatApiDirty}
        />}
        {section === 'update' && <UpdatePanel onInstall={onInstallUpdate} installDisabled={installUpdateDisabled || hasDirty} unsavedSettings={hasDirty} />}
        {section === 'data' && <section>
          <h2>本地数据</h2>
          <p className="muted">缓存与笔记分开保存。清理缓存不会删除笔记。</p>
          <div className="data-actions">
            <button type="button" className="btn-danger" disabled={!documentKey} onClick={() => { void dataAction(() => repository.clearCache(documentKey), '当前文档缓存已清理'); }}>清理当前文档缓存</button>
            <button type="button" className="btn-secondary" onClick={() => { void dataAction(() => exportNotes(repository.snapshot.notes), '笔记导出操作已完成'); }}>导出全部笔记</button>
          </div>
          <p className="muted">最近文件与笔记可在顶部左侧“文档导航”面板中管理。</p>
        </section>}
        {notice && <p className="settings-notice" role="status">{notice}</p>}
      </div>
    </div>}
    {pendingAction && <div className="settings-confirm" role="alert">
      <p>当前有未保存的设置更改（{dirtySummary}）。</p>
      <button type="button" className="btn-secondary" onClick={() => setPendingAction(null)}>继续编辑</button>
      <button type="button" className="btn-danger" onClick={confirmDiscard}>
        {pendingAction.type === 'close' ? '放弃未保存设置并关闭' : '放弃更改并切换'}
      </button>
    </div>}
  </dialog>;
}
