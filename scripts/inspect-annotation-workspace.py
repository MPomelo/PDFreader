"""Check standard PDF annotation dictionaries and verify the FreeText ink with Poppler."""
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

from PIL import Image, ImageChops
from pypdf import PdfReader


def annotations(path):
    return [
        ref.get_object() for ref in PdfReader(path).pages[0].get('/Annots', [])
        if ref.get_object().get('/Subtype') in {'/Underline', '/StrikeOut', '/Text', '/FreeText'}
    ]


original, exported, reopened = sys.argv[1:]
for path, note, textbox in [
    (exported, '导出后仍可编辑的中文注释', '科研笔记：这是一个可换行的中文文本框。\n第二行 mixed text，包含标点。'),
    (reopened, '重新打开后修改注释', '重新打开后修改文本框\nUpdated text'),
]:
    entries = {str(entry['/Subtype']): entry for entry in annotations(path)}
    assert len(entries) == 4, entries.keys()
    assert entries['/Text']['/Contents'] == note, entries['/Text'].get('/Contents')
    box = entries['/FreeText']
    assert box['/Contents'] == textbox, box.get('/Contents')
    assert b'BI /W' in box['/AP']['/N'].get_data()
    assert b'/IM true' in box['/AP']['/N'].get_data()
    assert abs(float(box['/Rect'][2] - box['/Rect'][0]) - 90) < 2, box['/Rect']
    position = (float(box['/Rect'][0]), float(box['/Rect'][3]))
    if path == exported:
        initial_position = position
    else:
        assert all(abs(a - b) < 1 for a, b in zip(position, initial_position)), (position, initial_position)
    for name in ['/Underline', '/StrikeOut']:
        assert len(entries[name]['/QuadPoints']) >= 8
        assert entries[name]['/AP']['/N'].get_data()
    with TemporaryDirectory() as tmp:
        outputs = []
        for index, source in enumerate([original, path]):
            target = Path(tmp) / str(index)
            subprocess.run(['pdftoppm', '-f', '1', '-l', '1', '-scale-to', '792',
                            '-singlefile', '-png', source, str(target)], check=True)
            outputs.append(Image.open(target.with_suffix('.png')).convert('RGB'))
        x0, y0, x1, y1 = (float(value) for value in box['/Rect'])
        page = PdfReader(path).pages[0]
        scale = outputs[0].height / float(page.mediabox.height)
        area = (round(x0 * scale), round(outputs[0].height - y1 * scale),
                round(x1 * scale), round(outputs[0].height - y0 * scale))
        difference = ImageChops.difference(outputs[0].crop(area), outputs[1].crop(area))
        changed = sum(pixel != (0, 0, 0) for pixel in difference.getdata())
        assert 40 < changed < difference.width * difference.height * .75, changed
