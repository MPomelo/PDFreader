export const columns = ['upper', 'lower', 'right'] as const;
export type Column = typeof columns[number];
export const columnName: Record<Column, string> = { upper: '上栏', lower: '下栏', right: '右栏' };

export type Workspace = {
  order: Record<Column, string[]>;
  selected: Record<Column, string>;
  focus: Column;
  collapsed: Record<Column, boolean>;
  lowerShare: number;
  rightShare: number;
};
export type Resource = { id: string; kind: 'pdf' | 'markdown' | 'txt' | 'chat' | 'translation'; name: string; path?: string; source?: string; fingerprint?: string };
export type SavedWorkspace = Workspace & { version: 1; resources: Resource[] };

export function defaultWorkspace(): Workspace {
  return {
    order: { upper: [], lower: [], right: [] },
    selected: { upper: '', lower: '', right: '' },
    focus: 'upper', collapsed: { upper: false, lower: true, right: true },
    lowerShare: 0.4, rightShare: 0.34,
  };
}

export function columnOf(workspace: Workspace, id: string) {
  return columns.find(column => workspace.order[column].includes(id));
}

export function select(workspace: Workspace, column: Column, id = workspace.selected[column]): Workspace {
  return {
    ...workspace, focus: column,
    selected: { ...workspace.selected, [column]: id },
    collapsed: { ...workspace.collapsed, [column]: false },
  };
}

export function remove(workspace: Workspace, id: string): Workspace {
  const column = columnOf(workspace, id);
  if (!column) return workspace;
  const before = workspace.order[column];
  const remaining = before.filter(item => item !== id);
  const selected = workspace.selected[column] === id
    ? remaining[Math.min(before.indexOf(id), remaining.length - 1)] ?? ''
    : workspace.selected[column];
  return { ...workspace, order: { ...workspace.order, [column]: remaining }, selected: { ...workspace.selected, [column]: selected } };
}

export function move(workspace: Workspace, id: string, column: Column, before?: string): Workspace {
  if (id === before) return select(workspace, column, id);
  const next = remove(workspace, id);
  const order = [...next.order[column]];
  const index = before ? order.indexOf(before) : -1;
  order.splice(index < 0 ? order.length : index, 0, id);
  return select({ ...next, order: { ...next.order, [column]: order } }, column, id);
}

export function readWorkspace(value: unknown): SavedWorkspace | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as SavedWorkspace;
  if (data.version !== 1 || !columns.includes(data.focus) || !Array.isArray(data.resources) ||
    ![data.lowerShare, data.rightShare].every(share => Number.isFinite(share) && share >= 0.15 && share <= 0.85)) return null;
  if (!data.resources.every(resource => resource && typeof resource.id === 'string' && /^[a-f0-9-]{36}$/.test(resource.id) &&
    ['pdf', 'markdown', 'txt', 'chat', 'translation'].includes(resource.kind) && typeof resource.name === 'string' &&
    (resource.source === undefined || typeof resource.source === 'string') &&
    (resource.fingerprint === undefined || typeof resource.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(resource.fingerprint)) &&
    (['chat', 'translation'].includes(resource.kind) || typeof resource.path === 'string' && !!resource.path))) return null;
  const ids = new Set(data.resources.map(resource => resource.id));
  for (const column of columns) {
    const order = data.order?.[column];
    if (!Array.isArray(order) || typeof data.collapsed?.[column] !== 'boolean' ||
      data.selected?.[column] !== '' && !order.includes(data.selected?.[column])) return null;
    for (const id of order) if (!ids.delete(id)) return null;
  }
  return data.collapsed[data.focus] || ids.size || new Set(data.resources.map(resource => resource.id)).size !== data.resources.length ? null : data;
}

export function saveWorkspace(workspace: Workspace, resources: Resource[]): SavedWorkspace {
  const ids = new Set(resources.map(resource => resource.id));
  let next = workspace;
  for (const column of columns) for (const id of workspace.order[column]) if (!ids.has(id)) next = remove(next, id);
  return { ...next, version: 1, resources };
}
