import { Checkmark16Regular, Pin16Regular } from '@fluentui/react-icons';
import { columns, columnName, type Column } from './layout';

export function TranslationSource({ source, canPin, available, onFollow, onPin }: {
  source: string; available: boolean; canPin: boolean; onFollow: (column: Column) => void; onPin: () => void;
}) {
  const followed = columns.find(column => column === source);
  const description = (followed ? '跟随' + columnName[followed] : '固定来源') + (available ? '' : ' · 来源暂不可用');
  return <details className="toolbar-menu translation-source-menu">
    <summary role="button" aria-label={'译文来源 · ' + description} title={description}>
      {followed ? <span className="translation-source-icon" aria-hidden="true" data-follow={followed}>
        {columns.map(column => <span key={column} data-region={column} />)}
      </span> : <Pin16Regular />}
    </summary>
    <div className="command-menu" role="group" aria-label="选择译文来源" onClick={event => {
      if ((event.target as Element).closest('button')) event.currentTarget.parentElement?.removeAttribute('open');
    }}>
      {columns.map(column => <button key={column} aria-pressed={column === followed} onClick={() => onFollow(column)}>
        跟随{columnName[column]}{column === followed && <Checkmark16Regular />}
      </button>)}
      <button disabled={!canPin} aria-pressed={!followed} onClick={onPin}>固定当前 PDF{!followed && <Checkmark16Regular />}</button>
    </div>
  </details>;
}
