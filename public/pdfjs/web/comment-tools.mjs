export function hasCommentDraft(root) {
  return !!root.getElementById('commentManagerDialog')?.open &&
    root.getElementById('commentManagerSaveButton')?.disabled === false;
}

// Flush a note draft just like a free-text editor before export / leave. Closing
// an unchanged dialog also prevents an old document's editor remaining active.
export function commitCommentDraft(root) {
  if (!root.getElementById('commentManagerDialog')?.open) return;
  const button = root.getElementById(hasCommentDraft(root) ? 'commentManagerSaveButton' : 'commentManagerCancelButton');
  button?.click();
}
