export type LeaveChoice = 'save' | 'discard' | 'cancel';

// Flush active editor content before deciding; a cancelled/failed save is never
// permission to switch the document or destroy the native window.
export async function mayLeaveDocument(
  flush: () => Promise<{ dirty: boolean }>,
  choose: () => Promise<LeaveChoice>,
  save: () => Promise<boolean>,
): Promise<boolean> {
  if (!(await flush()).dirty) return true;
  const choice = await choose();
  if (choice === 'cancel') return false;
  if (choice === 'discard') return true;
  return save();
}
