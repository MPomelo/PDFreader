import { useEffect, useRef, useState } from 'react';
import { encodings, type TextEncoding } from './document';

export function EncodingDialog({ name, error, onAnswer }: { name: string; error: string; onAnswer: (encoding: TextEncoding | null) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [encoding, setEncoding] = useState<TextEncoding>('GB18030');
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="unsaved-dialog text-encoding-dialog" aria-labelledby="encoding-title" onCancel={event => {
    event.preventDefault();
    onAnswer(null);
  }}>
    <form onSubmit={event => { event.preventDefault(); onAnswer(encoding); }}>
      <h2 id="encoding-title">选择文件编码</h2>
      <p>无法按 UTF-8 读取“{name}”。请选择该文件使用的编码。</p>
      {error && <p role="alert">{error}</p>}
      <label>文件编码<select value={encoding} onChange={event => setEncoding(event.target.value as TextEncoding)}>
        {encodings.map(value => <option key={value}>{value}</option>)}
      </select></label>
      <div className="dialog-actions">
        <button type="button" onClick={() => onAnswer(null)}>取消</button>
        <button type="submit" className="primary">打开</button>
      </div>
    </form>
  </dialog>;
}
