import { useSyncExternalStore } from 'react';
import type { TextTab } from './document';

export type TextCursor = TextTab['position'];
const DEFAULT_CURSOR: TextCursor = { line: 1, column: 1 };

const positions = new Map<string, TextCursor>();
const listeners = new Map<string, Set<() => void>>();

function notify(id: string) {
  listeners.get(id)?.forEach(listener => listener());
}

export const cursorStore = {
  set(id: string, position: TextCursor) {
    const current = positions.get(id);
    if (current && current.line === position.line && current.column === position.column) return;
    positions.set(id, position);
    notify(id);
  },
  delete(id: string) {
    if (!positions.delete(id)) return;
    notify(id);
  },
  get(id: string) {
    return positions.get(id);
  },
  subscribe(id: string, listener: () => void) {
    let bucket = listeners.get(id);
    if (!bucket) {
      bucket = new Set();
      listeners.set(id, bucket);
    }
    bucket.add(listener);
    return () => {
      bucket!.delete(listener);
      if (!bucket!.size) listeners.delete(id);
    };
  },
};

export function useTextCursor(id: string, fallback: TextCursor = DEFAULT_CURSOR): TextCursor {
  return useSyncExternalStore(
    listener => (id ? cursorStore.subscribe(id, listener) : () => {}),
    () => (id ? cursorStore.get(id) ?? fallback : fallback),
  );
}
