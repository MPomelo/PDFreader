import { useLayoutEffect, useRef, type ReactNode } from 'react';
import type { Column } from './layout';

export function WorkspaceHeader({ column, children }: { column: Column; children: ReactNode }) {
  const header = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = header.current!;
    const grid = element.closest<HTMLElement>('.workspace-grid')!;
    const variable = '--workspace-header-' + column;
    const measure = () => grid.style.setProperty(variable, element.offsetHeight + 'px');
    const observer = new ResizeObserver(measure);
    measure();
    observer.observe(element);
    return () => { observer.disconnect(); grid.style.removeProperty(variable); };
  }, [column]);
  return <div className="workspace-column-head" ref={header}>
    <div className="workspace-focus-line" aria-hidden="true" />
    {children}
  </div>;
}
