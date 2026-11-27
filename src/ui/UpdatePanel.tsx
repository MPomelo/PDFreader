import { useEffect, useState } from 'react';
import { Channel, invoke, isTauri } from '@tauri-apps/api/core';

type UpdateInfo = { version: string; prerelease: boolean; size: number };
type UpdateStatus = { currentVersion: string; available: UpdateInfo | null; downloaded: boolean; busy: boolean; downloading: boolean };
type DownloadProgress = { downloaded: number; total: number };
const mib = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);

export function UpdatePanel({ onInstall, installDisabled, unsavedSettings }: {
  onInstall: () => Promise<string | void>;
  installDisabled: boolean;
  unsavedSettings: boolean;
}) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [prerelease, setPrerelease] = useState(true);
  const [work, setWork] = useState<'check' | 'download' | 'install' | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [message, setMessage] = useState('');
  const busy = !!work || !!status?.busy;
  const downloading = work === 'download' || !!status?.downloading;

  useEffect(() => {
    if (!isTauri()) return;
    let current = true;
    void invoke<UpdateStatus>('update_status').then(value => {
      if (current) setStatus(value);
    }).catch(error => { if (current) setMessage(String(error)); });
    return () => { current = false; };
  }, []);

  // Recover the download state if the user reopens settings while a job is running.
  useEffect(() => {
    if (!status?.busy || work) return;
    let current = true;
    const timer = window.setInterval(() => {
      void invoke<UpdateStatus>('update_status').then(value => { if (current) setStatus(value); }).catch(() => {});
    }, 750);
    return () => { current = false; window.clearInterval(timer); };
  }, [status?.busy, work]);

  async function perform(kind: NonNullable<typeof work>) {
    setWork(kind);
    setMessage('');
    if (kind === 'download') setProgress(null);
    try {
      if (kind === 'check') {
        const result = await invoke<UpdateStatus>('update_check', { includePrerelease: prerelease });
        setStatus(result);
        if (!result.available) setMessage(prerelease ? '当前已是最新版本。' : '没有可用的正式版更新。');
      } else if (kind === 'download') {
        const onProgress = new Channel<DownloadProgress>(setProgress);
        try { setStatus(await invoke<UpdateStatus>('update_download', { onProgress })); }
        finally { onProgress.onmessage = () => {}; }
      } else {
        const error = await onInstall();
        if (error) {
          setMessage(error);
          setStatus(await invoke<UpdateStatus>('update_status'));
        }
      }
    } catch (error) { setMessage(String(error)); }
    finally { setWork(null); }
  }

  if (!isTauri()) return <section><h2>应用更新</h2><p>请在 Windows 桌面应用中检查更新。</p></section>;
  const available = status?.available;
  const selected = available && (!available.prerelease || prerelease) ? available : null;
  return <section>
    <h2>应用更新</h2>
    <p className="muted">{status ? `当前版本 ${status.currentVersion}` : '正在读取当前版本…'}</p>
    <label className="checkbox"><input type="checkbox" checked={prerelease} disabled={busy}
      onChange={event => { setPrerelease(event.target.checked); setMessage(''); }} />包括预发行版</label>
    <div className="panel-actions">
      <button type="button" className={selected ? 'btn-secondary' : 'btn-primary'} disabled={busy} onClick={() => { void perform('check'); }}>检查更新</button>
      {selected && !status?.downloaded && !downloading && <button type="button" className="btn-primary" disabled={busy}
        onClick={() => { void perform('download'); }}>下载更新</button>}
      {downloading && <button type="button" className="btn-secondary" onClick={() => { void invoke('update_cancel_download').catch(error => setMessage(String(error))); }}>取消下载</button>}
    </div>
    {selected && <p>可更新到 <strong>{selected.version}</strong>{selected.prerelease ? '（预发行版）' : ''} · {mib(selected.size)} MiB</p>}
    {downloading && <div className="field">
      <progress aria-label="安装包下载进度" max={progress?.total} value={progress?.downloaded} />
      <span className="muted">{progress ? `已下载 ${mib(progress.downloaded)} / ${mib(progress.total)} MiB` : '正在连接下载服务…'}</span>
    </div>}
    {selected && status?.downloaded && <>
      <p>安装包已通过 SHA-256 校验。退出前会检查尚未保存的文档，随后打开 Windows 安装程序。</p>
      {unsavedSettings && <p className="muted">请先保存未保存的设置更改。</p>}
      <button type="button" className="btn-primary" disabled={busy || installDisabled} onClick={() => { void perform('install'); }}>退出并安装</button>
    </>}
    {work === 'check' && <p role="status">正在检查更新…</p>}
    {message && <p role="status">{message}</p>}
  </section>;
}
