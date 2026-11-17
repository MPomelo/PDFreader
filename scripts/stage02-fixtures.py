"""Small local QA inputs, never modifications to a user's PDFs."""
from pathlib import Path
import zlib
from pypdf import PdfWriter, PdfReader
from pypdf.generic import DictionaryObject, NameObject, NumberObject, DecodedStreamObject
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
