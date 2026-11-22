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
