import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { SecretStatus } from '../translation/client';

export type ApiKeyFieldProps = {
  /** 切换服务或配置时用于自动清空密码输入框 */
  resetKey: string;
  status: SecretStatus | null;
  statusPrefix?: string;
  statusSuffix?: string;
  missingText?: string;
  unavailableText?: string;
  legend?: string;
  inputLabel?: string;
  inputPlaceholder?: string;
  sessionOnlyLabel?: string;
  saveLabel?: string;
  deleteLabel?: string;
  disabled?: boolean;
  deleteDisabled?: boolean;
  extraActions?: ReactNode;
  feedback?: string;
  onSave: (key: string, sessionOnly: boolean) => Promise<void> | void;
  onDelete: () => Promise<void> | void;
};

function describeStatus(status: SecretStatus | null, missingText: string, unavailableText: string) {
  if (status?.available) {
    return status.mode === 'session' ? '已配置 · 仅本次会话' : '已配置 · Windows 凭据管理器';
  }
  if (status?.mode === 'unavailable') return unavailableText;
  return missingText;
}

export function ApiKeyField({
  resetKey,
  status,
  statusPrefix = '',
  statusSuffix = '',
  missingText = '尚未配置可用密钥。',
  unavailableText = '凭据管理器不可用，可选择仅本次会话。',
  legend = 'API 密钥',
  inputLabel = 'API 密钥',
  inputPlaceholder,
  sessionOnlyLabel = '仅本次会话（不保存本次密钥）',
  saveLabel = '保存密钥',
  deleteLabel = '删除密钥',
  disabled = false,
  deleteDisabled = false,
  extraActions,
  feedback,
  onSave,
  onDelete,
}: ApiKeyFieldProps) {
  const [sessionOnly, setSessionOnly] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (inputRef.current) inputRef.current.value = '';
  }, [resetKey]);

  async function handleSave() {
    const input = inputRef.current;
    const value = input?.value ?? '';
    try {
      await onSave(value, sessionOnly);
    } finally {
      if (input) input.value = '';
    }
  }

  const statusText = describeStatus(status, missingText, unavailableText);

  return <fieldset className="key-settings">
    <legend>{legend}</legend>
    <p className="muted">{statusPrefix}{statusText}{statusSuffix}</p>
    <label className="field">
      {inputLabel}
      <input
        ref={inputRef}
        type="password"
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        placeholder={inputPlaceholder}
      />
    </label>
    <label className="checkbox">
      <input
        type="checkbox"
        checked={sessionOnly}
        disabled={disabled}
        onChange={event => setSessionOnly(event.target.checked)}
      />
      {sessionOnlyLabel}
    </label>
    <div className="panel-actions">
      <button type="button" className="btn-secondary" disabled={disabled} onClick={() => { void handleSave(); }}>{saveLabel}</button>
      <button type="button" className="btn-danger" disabled={disabled || deleteDisabled} onClick={() => { void onDelete(); }}>{deleteLabel}</button>
      {extraActions}
    </div>
    {feedback && <p className="muted" role="status">{feedback}</p>}
  </fieldset>;
}
