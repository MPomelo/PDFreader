import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Dismiss20Regular, Subtract20Regular, Square20Regular, SquareMultiple20Regular } from '@fluentui/react-icons';

export function WindowControls({ busy, onClose, onError }: { busy: boolean; onClose: () => void; onError: (message: string) => void }) {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    const window = getCurrentWindow();
    let mounted = true;
    const update = () => { void window.isMaximized().then(value => { if (mounted) setMaximized(value); }).catch(() => {}); };
    const listener = window.onResized(update);
    void listener.then(update).catch(() => {});
    return () => { mounted = false; void listener.then(unlisten => unlisten()).catch(() => {}); };
  }, []);

  function run(operation: 'minimize' | 'toggleMaximize') {
    void getCurrentWindow()[operation]().catch(error => onError(String(error)));
  }

  const sizeLabel = maximized ? '还原窗口' : '最大化';
  return <div className="window-controls" role="group" aria-label="窗口控制">
    <button aria-label="最小化" title="最小化" onClick={() => run('minimize')}><Subtract20Regular /></button>
    <button aria-label={sizeLabel} title={sizeLabel} onClick={() => run('toggleMaximize')}>{maximized ? <SquareMultiple20Regular /> : <Square20Regular />}</button>
    <button className="window-close" aria-label="关闭窗口" title="关闭窗口" disabled={busy} onClick={onClose}><Dismiss20Regular /></button>
  </div>;
}
