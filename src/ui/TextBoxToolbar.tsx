import { useEffect, useState } from 'react';
import { Checkmark20Regular } from '@fluentui/react-icons';
import type { TextBoxStyle, TextBoxStyleChange } from '../reader/ReaderAdapter';
import './textbox-toolbar.css';

type Props = {
  value: TextBoxStyle;
  busy: boolean;
  onChange: (change: TextBoxStyleChange) => void;
  onDone: () => void;
};

export function TextBoxToolbar({ value, busy, onChange, onDone }: Props) {
  const [size, setSize] = useState(String(value.size));
  useEffect(() => setSize(String(value.size)), [value.size, value.target]);
  function commitSize(input: string) {
    const number = Number(input);
    if (!input || !Number.isInteger(number) || number < 5 || number > 100) setSize(String(value.size));
    else if (number !== value.size) onChange({ property: 'size', value: number });
  }
  return <div className="textbox-toolbar" role="group" aria-label="文本框设置" data-pdfreader-text-toolbar data-text-target={value.target || undefined} onKeyDown={event => {
    if (event.nativeEvent.isComposing || event.keyCode === 229 || busy) return;
    if (event.key === 'Escape' || event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.shiftKey) {
      event.preventDefault();
      if (event.target instanceof HTMLInputElement && event.target.type === 'number') commitSize(event.target.value);
      onDone();
    }
  }}>
    <label>字号
      <input type="number" aria-label="字号" min="5" max="100" step="1" value={size} disabled={busy}
        onChange={event => setSize(event.target.value)} onBlur={event => commitSize(event.currentTarget.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            commitSize(event.currentTarget.value);
          }
        }} />
      <span aria-hidden="true">pt</span>
    </label>
    <label>文字色
      <input type="color" value={/^#[0-9a-f]{6}$/i.test(value.color) ? value.color : '#000000'} disabled={busy}
        onChange={event => onChange({ property: 'color', value: event.target.value })} />
    </label>
    <label>背景
      <select value={value.whiteBackground ? 'white' : 'transparent'} disabled={busy}
        onChange={event => onChange({ property: 'background', value: event.target.value === 'white' })}>
        <option value="transparent">透明</option>
        <option value="white">白底</option>
      </select>
    </label>
    <button type="button" className="textbox-done" disabled={busy} onClick={onDone}><Checkmark20Regular aria-hidden="true" />完成</button>
  </div>;
}
