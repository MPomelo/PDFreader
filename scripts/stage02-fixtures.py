"""Small local QA inputs, never modifications to a user's PDFs."""
from pathlib import Path
import zlib
from pypdf import PdfWriter, PdfReader
from pypdf.generic import ArrayObject, DictionaryObject, NameObject, NumberObject, DecodedStreamObject
from pypdf.annotations import Link
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[1] / 'test-results' / 'stage02'
root.mkdir(parents=True, exist_ok=True)

writer = PdfWriter()
for number in range(2):
    page = writer.add_blank_page(width=612, height=792)
    font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica')})
    page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): writer._add_object(font)})})
    stream = DecodedStreamObject()
    stream.set_data(f'BT /F1 18 Tf 72 720 Td (Stage02 reading target - page {number+1}) Tj 0 -50 Td (Select text, search target, and follow the page link.) Tj ET'.encode())
    page[NameObject('/Contents')] = writer._add_object(stream)
writer.add_outline_item('Second page', 1)
writer.add_annotation(0, Link(rect=(72, 660, 500, 685), target_page_index=1))
with (root / 'reading.pdf').open('wb') as file:
    writer.write(file)

# Content-stream order deliberately differs from the reading order on the page.
layout = PdfWriter()
layout.add_metadata({'/Title': 'Reading Order', '/Author': 'Mira Chen; Lin, Bo', '/CreationDate': 'D:20241201000000Z'})
xmp = DecodedStreamObject()
xmp.update({NameObject('/Type'): NameObject('/Metadata'), NameObject('/Subtype'): NameObject('/XML')})
xmp.set_data(b'''<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:prism="http://prismstandard.org/namespaces/basic/2.0/"
    prism:publicationDate="2025-05-24" prism:volume="12" prism:number="3" prism:startingPage="15" prism:endingPage="26">
    <dc:title><rdf:Alt><rdf:li xml:lang="x-default">Geometry and Reading Order</rdf:li></rdf:Alt></dc:title>
    <prism:publicationName>Journal of Example Layouts</prism:publicationName>
  </rdf:Description>
</rdf:RDF>''')
layout.root_object[NameObject('/Metadata')] = layout._add_object(xmp)
structure = DictionaryObject({NameObject('/Type'): NameObject('/StructTreeRoot')})
structure_ref = layout._add_object(structure)
layout.root_object[NameObject('/StructTreeRoot')] = structure_ref
for number in range(1, 3):
    page = layout.add_blank_page(width=612, height=792)
    font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica')})
    page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): layout._add_object(font)})})
    lines = [
        (14, 72, 690, f'Left first line page {number}'),
        (14, 337, 690, f'Right first line page {number}'),
        (10, 72, 48, 'Journal footer label'),
        (10, 72, 741, 'Journal running header'),
        (14, 72, 670, f'Left second line page {number}'),
        (14, 337, 670, f'Right second line page {number}'),
        (10, 72, 370, 'Figure 1. A separate caption'),
        (10, 72, 357, 'Continuation of the figure caption'),
        (10, 337, 370, 'Table 1: Another caption'),
        (10, 72, 117, '1. Footnote details'),
        (10, 72, 104, 'Continuation of the footnote'),
        (10, 302, 31, str(number)),
        (10, 337, 48, 'DOI: 10.1234/layout.2025'),
    ]
    stream = DecodedStreamObject()
    contents = ''.join(f'BT /F1 {size} Tf {x} {y} Td ({text}) Tj ET\n' for size, x, y, text in lines)
    if number == 1:
        caption = layout._add_object(DictionaryObject({
            NameObject('/Type'): NameObject('/StructElem'), NameObject('/S'): NameObject('/Caption'),
            NameObject('/P'): structure_ref, NameObject('/Pg'): page.indirect_reference,
            NameObject('/K'): ArrayObject([NumberObject(0), NumberObject(1)]),
        }))
        structure[NameObject('/K')] = ArrayObject([caption])
        contents += ('/Caption <</MCID 0>> BDC BT /F1 14 Tf 72 530 Td (An accessible caption) Tj ET EMC\n'
                     '/Caption <</MCID 1>> BDC BT /F1 14 Tf 72 510 Td (Second tagged line) Tj ET EMC\n')
    stream.set_data(contents.encode())
    page[NameObject('/Contents')] = layout._add_object(stream)
layout.write(root / 'precise-selection.pdf')

# Dense journal layout. The 12-point gutter is narrower than the old line-joining tolerance.
journal = PdfWriter()
page = journal.add_blank_page(width=612, height=792)
font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Courier')})
page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): journal._add_object(font)})})
left = [(10, 28, 620 - index * 12, f'Near left row {index + 1:02d} samples only this paragraph text'[:46]) for index in range(10)]
right = [(10, 316, 560 - index * 12, f'Near right row {index + 1:02d} belongs to distinct prose'[:46]) for index in range(7)]
captions = [
    (8.5, 316, 608, 'Fig. 1. An illustration and its explanation'),
    (8.5, 316, 596, 'Caption continuation with a separate label.'),
    (8.5, 316, 584, 'Final caption sentence for this diagram.'),
]
stream = DecodedStreamObject()
stream.set_data(('0.85 g 316 622 264 38 re f 0 g\n' + ''.join(
    f'BT /F1 {size} Tf {x} {y} Td ({text}) Tj ET\n'
    for size, x, y, text in [(23, 30, 710, 'Journal title spans both columns here')] + list(reversed(right)) + left + captions
)).encode())
page[NameObject('/Contents')] = journal._add_object(stream)
journal.write(root / 'narrow-columns.pdf')

spacing = PdfWriter()
courier = spacing._add_object(font)
for page_width, gap in ((612, 3), (842, 4), (842, 6), (612, 18), (612, 48)):
    page = spacing.add_blank_page(width=page_width, height=792)
    page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): courier})})
    left_rows = [f'Left gap {gap:02d} row {row + 1:02d} holds only this column prose'[:46] for row in range(10)]
    right_rows = [f'Right gap {gap:02d} row {row + 1:02d} stays in independent prose'[:46] for row in range(10)]
    rows = [(page_width / 2 + gap, 620 - row * 13 + row % 2 * 2, right_rows[row]) for row in reversed(range(10))]
    rows += [(page_width / 2 - 46 * 6, 620 - row * 13, left_rows[row][:-8] if row in (2, 5) else left_rows[row]) for row in range(10)]
    stream = DecodedStreamObject()
    stream.set_data(''.join(f'BT /F1 10 Tf {x} {y} Td ({text}) Tj ET\n' for x, y, text in rows).encode())
    page[NameObject('/Contents')] = spacing._add_object(stream)

page = spacing.add_blank_page(width=612, height=792)
bold = spacing._add_object(DictionaryObject({NameObject('/Type'): NameObject('/Font'),
    NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Courier-Bold')}))
page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): courier, NameObject('/F2'): bold})})
before, after = 'Single column text continues into the', 'second half of the same line of prose'
stream = DecodedStreamObject()
stream.set_data(''.join(
    f'BT /F1 10 Tf 64 {620 - row * 13} Td ({before}) Tj /F2 10 Tf {(len(before) + 1) * 6} 0 Td ({after}) Tj ET\n'
    for row in range(8)
).encode())
page[NameObject('/Contents')] = spacing._add_object(stream)
spacing.write(root / 'column-spacing.pdf')

protected = PdfWriter(clone_from=PdfReader(root / 'reading.pdf'))
protected.encrypt('stage02', algorithm='RC4-128')
with (root / 'password.pdf').open('wb') as file:
    protected.write(file)

image = Image.new('RGB', (800, 180), 'white')
draw = ImageDraw.Draw(image)
draw.text((50, 70), 'SCANNED PAGE: image only, no selectable text.', fill='black', font_size=24)
scan = PdfWriter()
page = scan.add_blank_page(width=612, height=792)
pixels = DecodedStreamObject()
pixels.set_data(image.tobytes())
pixels.update({NameObject('/Type'): NameObject('/XObject'), NameObject('/Subtype'): NameObject('/Image'),
    NameObject('/Width'): NumberObject(image.width), NameObject('/Height'): NumberObject(image.height),
    NameObject('/ColorSpace'): NameObject('/DeviceRGB'), NameObject('/BitsPerComponent'): NumberObject(8)})
page[NameObject('/Resources')] = DictionaryObject({NameObject('/XObject'): DictionaryObject({NameObject('/Im0'): scan._add_object(pixels.flate_encode())})})
stream = DecodedStreamObject(); stream.set_data(b'q 510 0 0 115 50 620 cm /Im0 Do Q')
page[NameObject('/Contents')] = scan._add_object(stream)
with (root / 'scanned.pdf').open('wb') as file:
    scan.write(file)
print(root)
