export type PanelWidths = { left: number; right: number };
export const DEFAULT_WIDTHS: PanelWidths = { left: 220, right: 340 };
export const WIDTHS_KEY = 'pdfreader.panel-widths.v1';
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, Math.max(min, max)));
export function parseWidths(json: string | null): PanelWidths {
  try {
    const value = JSON.parse(json || 'null');
    return { left: Number.isFinite(value?.left) ? clamp(value.left, 160, 400) : 220, right: Number.isFinite(value?.right) ? clamp(value.right, 280, 720) : 340 };
  } catch { return { ...DEFAULT_WIDTHS }; }
}
export function panelLayout(preferred: PanelWidths, viewport: number, left: boolean, right: boolean) {
  const overlay = viewport <= 1000;
  const leftMax = Math.max(160, Math.min(400, viewport - 360 - (right && !overlay ? 280 : 0) - 12));
  const leftWidth = left ? clamp(preferred.left, 160, leftMax) : 0;
  const rightMax = Math.max(280, Math.min(720, overlay ? viewport - 80 : viewport - 360 - leftWidth - 12));
  return { left: leftWidth, right: right ? clamp(preferred.right, 280, rightMax) : 0, leftMax, rightMax, overlay };
}
