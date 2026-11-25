// Selection quads remain untouched. Coalesce only ordinary gaps within one row.
export function lineMarkupBoxes(boxes, markup, [pageWidth, pageHeight]) {
  const rows = [];
  const ordered = [...boxes].sort((a, b) => a.y - b.y || a.x - b.x);
  for (const box of ordered) {
    const middle = box.y + box.height / 2;
    const row = rows.find(row => Math.abs(row.middle - middle) <= Math.min(row.height, box.height) * 0.28);
    if (row) row.boxes.push(box);
    else rows.push({ middle, height: box.height, boxes: [box] });
  }
  const marks = [];
  for (const { boxes: row } of rows) {
    let run, previous;
    for (const box of row.sort((a, b) => a.x - b.x)) {
      const right = box.x + box.width;
      const ordinaryGap = Math.min(7, Math.min(previous?.height || 0, box.height) * pageHeight * 0.42) / pageWidth;
      if (run && box.x - run.right <= ordinaryGap) {
        run.right = Math.max(run.right, right);
      } else {
        const height = Math.min(0.6 / pageHeight, box.height * 0.13);
        const offset = markup === 'underline' ? box.height - height : (box.height - height) / 2;
        run = { x: box.x, y: box.y + offset, height, right };
        marks.push(run);
      }
      previous = box;
    }
  }
  return marks.map(({ x, y, height, right }) => ({ x, y, height, width: right - x }));
}
