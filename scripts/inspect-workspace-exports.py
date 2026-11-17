"""Independent PDF parser check for the browser/native per-tab export fixtures."""
import json
from pathlib import Path
from pypdf import PdfReader

root = Path(__file__).resolve().parents[1] / 'test-results' / 'workspace'

def contents(path):
    path = Path(path).resolve()
    assert path.parent == root.resolve(), 'Unexpected export location'
    return [str(annotation.get_object().get('/Contents', ''))
            for page in PdfReader(path).pages for annotation in (page.get('/Annots') or [])]

results = {}
a, b = contents(root / 'A-export.pdf'), contents(root / 'B-export.pdf')
assert 'ANNOTATION_A' in a and 'ANNOTATION_A' not in b
results['browser'] = {'a_has_own_annotation': True, 'b_has_no_a_annotation': True}
native = root / 'native-exports.json'
if native.exists():
    paths = json.loads(native.read_text(encoding='utf-8'))
    a, b = contents(paths['a']), contents(paths['b'])
    assert 'NATIVE_A_ONLY' in a and 'NATIVE_B_ONLY' not in a
    assert 'NATIVE_B_ONLY' in b and 'NATIVE_A_ONLY' not in b
    results['native'] = {'a_and_b_annotations_are_isolated': True}
(root / 'independent-export-evidence.json').write_text(json.dumps(results, indent=2), encoding='utf-8')
print(json.dumps(results, indent=2))
