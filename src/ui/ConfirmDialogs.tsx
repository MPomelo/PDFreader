import { useEffect, useRef } from 'react';
import type { LeaveChoice } from '../reader/leave-document';
import { columnOf, columnName, type Column, type Workspace } from '../workspace/layout';
import type { DocumentTab } from '../workspace/useWorkspaceStore';

export type UnsavedPrompt = { id: string; name: string; kind: DocumentTab['kind'] };
export type TranslationConflict = { id: string; to: Column };

type Props = {
  workspace: Workspace;
  translationConflict: TranslationConflict | null;
  onAnswerTranslationConflict: (choice: 'move' | 'locate' | 'cancel') => void;
  prompt: UnsavedPrompt | null;
  fallbackIsText: boolean;
  onAnswerLeave: (choice: LeaveChoice) => void;
};

export function ConfirmDialogs({
  workspace, translationConflict, onAnswerTranslationConflict, prompt, fallbackIsText, onAnswerLeave,
}: Props) {
  const translationDialog = useRef<HTMLDialogElement>(null);
  const leaveDialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const modal = translationDialog.current;
    if (translationConflict && !modal?.open) modal?.showModal();
    if (!translationConflict && modal?.open) modal.close();
  }, [translationConflict]);

  useEffect(() => {
    const modal = leaveDialog.current;
    if (prompt && !modal?.open) modal?.showModal();
    if (!prompt && modal?.open) modal.close();
  }, [prompt]);

  const promptIsText = prompt ? prompt.kind !== 'pdf' : fallbackIsText;

  return <>
    <dialog ref={translationDialog} className="unsaved-dialog translation-conflict" aria-labelledby="translation-conflict-title"
      onCancel={event => { event.preventDefault(); onAnswerTranslationConflict('cancel'); }}>
      {translationConflict && (() => {
        const from = columnOf(workspace, translationConflict.id);
        if (!from) return null;
        const to = translationConflict.to;
        return <>
          <h2 id="translation-conflict-title">译文已在{columnName[from]}打开</h2>
          <p>要把当前译文移到{columnName[to]}吗？</p>
          <div className="dialog-actions">
            <button type="button" className="btn-secondary" onClick={() => onAnswerTranslationConflict('cancel')}>取消</button>
            <button type="button" className="btn-secondary" onClick={() => onAnswerTranslationConflict('move')}>移到{columnName[to]}</button>
            <button type="button" className="btn-primary" autoFocus onClick={() => onAnswerTranslationConflict('locate')}>定位到{columnName[from]}</button>
          </div>
        </>;
      })()}
    </dialog>
    <dialog ref={leaveDialog} className="unsaved-dialog" aria-labelledby="unsaved-title"
      onCancel={event => { event.preventDefault(); onAnswerLeave('cancel'); }}>
      <h2 id="unsaved-title">{promptIsText ? '有尚未保存的修改' : '有尚未导出的修改'}</h2>
      <p>{promptIsText ? `是否保存“${prompt?.name}”的修改？` : `是否先导出“${prompt?.name}”的批注？`}</p>
      <div className="dialog-actions">
        <button type="button" className="btn-danger" onClick={() => onAnswerLeave('discard')}>放弃修改</button>
        <button type="button" className="btn-secondary" autoFocus onClick={() => onAnswerLeave('cancel')}>取消</button>
        <button type="button" className="btn-primary" onClick={() => onAnswerLeave('save')}>保存并继续</button>
      </div>
    </dialog>
  </>;
}
