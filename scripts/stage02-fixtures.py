"""Small local QA inputs, never modifications to a user's PDFs."""
from pathlib import Path
import zlib
from pypdf import PdfWriter, PdfReader
from pypdf.generic import ArrayObject, DecodedStreamObject, Destination, DictionaryObject, Fit, NameObject, NumberObject, TextStringObject
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

# Real PDF link annotations for hover preview, including an unloaded rotated destination.
links = PdfWriter()
link_font = links._add_object(DictionaryObject({
    NameObject('/Type'): NameObject('/Font'),
    NameObject('/Subtype'): NameObject('/Type1'),
    NameObject('/BaseFont'): NameObject('/Helvetica'),
}))

def link_page(rows, drawing=''):
    page = links.add_blank_page(width=612, height=792)
    page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): link_font})})
    data = DecodedStreamObject()
    data.set_data((drawing + '\n' + '\n'.join(
        f'BT /F1 {size} Tf {x} {y} Td ({text}) Tj ET' for size, x, y, text in rows
    )).encode())
    page[NameObject('/Contents')] = links._add_object(data)
    return page

link_page([
    (16, 72, 740, 'Link preview fixture'),
    (12, 72, 705, 'See Figure 3'), (12, 195, 705, '[12]'), (12, 252, 705, 'Table 2'),
    (12, 72, 665, 'Exact box'), (12, 195, 665, 'Entire page'),
    (12, 300, 665, 'External link'), (12, 428, 665, 'Broken destination'),
    (12, 72, 630, 'Selectable words for copy and markup'),
    (12, 72, 605, 'Next words for the search regression'),
])
link_page([
    (12, 52, 660, 'Left prose beside the picture'), (12, 52, 645, 'Passage in the other column'),
    (8, 350, 493, 'axis tick'),
    (8, 415, 493, 'trial index'),
    (10, 329, 475, 'Figure 3. Signal measured during trials.'),
    (10, 329, 462, 'Each color shows a different trial.'),
    (12, 52, 475, 'Unrelated narrow-column line'),
    (12, 52, 460, 'Another unrelated line'),
    (12, 329, 430, 'Text following the figure'),
], '0.12 0.54 0.8 rg 329 498 225 153 re f\n0 g')
link_page([
    (14, 56, 732, 'References'),
    (11, 55, 690, '[11] Earlier entry on the left.'),
    (11, 55, 678, '       Continuation of the earlier entry.'),
    (11, 55, 663, '[12] Mira Chen. Measurements across trials.'),
    (11, 75, 650, 'Example Journal of PDF Studies, 2024.'),
    (11, 55, 634, '[13] The next entry starts here.'),
    (11, 322, 663, '[27] Different entry in the right column.'),
    (11, 343, 650, 'And its continuation.'),
])
link_page([
    (11, 68, 717, 'Table 2. Sample counts.'),
    (10, 73, 671, 'Trial   Left   Right'),
    (10, 73, 641, 'One     9      12'),
    (10, 73, 611, 'Two     5      14'),
    (12, 68, 545, 'Body text resumes below the table after a gap.'),
], '.85 .85 .85 rg 68 590 195 96 re f\n0 g')
rotated = link_page([(12, 75, 450, 'Inside the exact region')], '0.7 0.2 0.1 rg 72 410 220 130 re f\n0 g')
rotated.cropbox.lower_left = (36, 36)
rotated.cropbox.upper_right = (576, 756)
rotated.rotate(90)
link_page([(25, 72, 705, 'Whole page destination')])

for rectangle, target, fit in [
    ((72, 699, 145, 719), 1, Fit.xyz(left=329, top=492, zoom=None)),
    ((252, 699, 300, 719), 3, Fit.fit_horizontally(top=725)),
    ((72, 659, 133, 679), 4, Fit.fit_rectangle(left=72, bottom=410, right=292, top=540)),
    ((195, 659, 262, 679), 5, Fit.fit()),
]:
    links.add_annotation(0, Link(rect=rectangle, target_page_index=target, fit=fit, border=[0, 0, 0]))

def named_link(rectangle, name):
    annotation = Link(rect=rectangle, target_page_index=0, border=[0, 0, 0])
    annotation[NameObject('/Dest')] = TextStringObject(name)
    links.add_annotation(0, annotation)

links.add_named_destination_array(
    TextStringObject('cite.chen'),
    Destination(TextStringObject('cite.chen'), links.pages[2].indirect_reference,
                Fit.xyz(left=55, top=672, zoom=None)).dest_array,
)
named_link((195, 699, 219, 719), 'cite.chen')
named_link((428, 659, 525, 679), 'missing.target')
links.add_annotation(0, Link(rect=(300, 659, 375, 679), url='https://example.invalid/', border=[0, 0, 0]))
links.write(root / 'link-preview.pdf')
