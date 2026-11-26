import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown20Regular, ChevronUp20Regular, Dismiss20Regular, Search20Regular } from '@fluentui/react-icons';
import type { FindOptions, ReaderAdapter, ReaderState } from '../reader/ReaderAdapter';

const optionLabels: ReadonlyArray<[keyof FindOptions, string]> = [
  ['highlightAll', '高亮全部'], ['caseSensitive', '区分大小写'],
  ['entireWord', '全字匹配'], ['matchDiacritics', '区分变音符号'],
];

export function DocumentFind({ adapter, result, disabled, keyboardActive = true }: {
  adapter?: ReaderAdapter; result?: ReaderState['find']; disabled: boolean; keyboardActive?: boolean;
}) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [requestId, setRequestId] = useState('');
  const [options, setOptions] = useState<FindOptions>({ highlightAll: false, caseSensitive: false, entireWord: false, matchDiacritics: false });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const composing = useRef(false);

  function search(term: string, settings = options, again = false, previous = false) {
    const id = crypto.randomUUID();
    setRequestId(id);
    adapter?.find(id, term, settings, again, previous);
  }
  function show() {
    if (open) {
      input.current?.focus();
      input.current?.select();
      return;
    }
    setOpen(true);
    if (query) search(query);
  }
  function close(restoreFocus: boolean) {
    setOpen(false);
    composing.current = false;
    setRequestId('');
    adapter?.closeFind();
    if (restoreFocus) trigger.current?.focus();
  }

  useEffect(() => () => adapter?.closeFind(), [adapter]);
  useEffect(() => {
    if (!disabled || !open) return;
    setOpen(false);
    composing.current = false;
    adapter?.closeFind();
  }, [adapter, disabled, open]);
  useLayoutEffect(() => {
    if (!open || disabled || !trigger.current || !panel.current) return;
    const button = trigger.current;
    const popup = panel.current;
    const position = () => {
      const x = button.getBoundingClientRect().left;
      const rightLimit = document.documentElement.clientWidth - popup.offsetWidth - 8;
      popup.style.left = `${Math.max(8, Math.min(x, rightLimit)) - x}px`;
    };
    position();
    input.current?.focus({ preventScroll: true });
    input.current?.select();
    window.addEventListener('resize', position);
    return () => window.removeEventListener('resize', position);
  }, [disabled, open]);
  useEffect(() => {
    if (disabled || !adapter || !keyboardActive) return;
    function keydown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'escape' && open) {
        event.preventDefault();
        close(true);
      } else if ((event.ctrlKey || event.metaKey) && key === 'f' && !event.shiftKey) {
        event.preventDefault();
        show();
      } else if ((event.ctrlKey || event.metaKey) && key === 'g' && query.trim()) {
        event.preventDefault();
        setOpen(true);
        search(query, options, true, event.shiftKey);
      }
    }
    window.addEventListener('keydown', keydown, true);
    return () => window.removeEventListener('keydown', keydown, true);
  });

  const visible = open && !disabled;
  const match = result?.requestId === requestId ? result : null;
  let status = '';
  if (query.trim() && requestId) {
    if (!match || match.status === 'pending') status = '正在查找…';
    else if (match.status === 'not-found') status = '未找到匹配项';
    else if (match.total > 0) {
      status = `${match.current} / ${match.total}`;
      if (match.status === 'wrapped') status += match.previous ? ' · 已回到文档末尾' : ' · 已回到文档开头';
    }
  }
  return <div className="document-find">
    <button ref={trigger} type="button" aria-label="查找" aria-expanded={visible} aria-controls={panelId}
      title="查找文档文字 (Ctrl+F)" disabled={disabled} onClick={() => visible ? close(true) : show()}><Search20Regular /></button>
    {visible && <div ref={panel} className="document-find-panel" id={panelId} role="search" aria-label="文档内查找">
      <div className="document-find-controls">
        <input ref={input} type="search" value={query} aria-label="查找文档文字" aria-invalid={match?.status === 'not-found'} placeholder="查找文档文字"
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={event => { composing.current = false; search(event.currentTarget.value); }}
          onChange={event => { setQuery(event.target.value); if (!composing.current) search(event.target.value); }}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing && !composing.current && query.trim()) {
              event.preventDefault();
              search(query, options, true, event.shiftKey);
            }
          }} />
        <button type="button" title="上一个匹配项 (Shift+Enter)" aria-label="上一个匹配项" disabled={!query.trim()}
          onClick={() => search(query, options, true, true)}><ChevronUp20Regular /></button>
        <button type="button" title="下一个匹配项 (Enter)" aria-label="下一个匹配项" disabled={!query.trim()}
          onClick={() => search(query, options, true)}><ChevronDown20Regular /></button>
        <button type="button" title="关闭查找 (Esc)" aria-label="关闭查找" onClick={() => close(true)}><Dismiss20Regular /></button>
      </div>
      <div className="document-find-options">{optionLabels.map(([key, label]) => <label key={key}>
        <input type="checkbox" checked={options[key]} onChange={event => {
          const next = { ...options, [key]: event.target.checked };
          setOptions(next);
          if (query) search(query, next);
        }} />{label}
      </label>)}</div>
      <div role="status" className="document-find-status">{status}</div>
    </div>}
  </div>;
}
