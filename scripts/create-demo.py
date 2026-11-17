"""Create original, redistributable PDFs for documentation screenshots."""
from pathlib import Path
from pypdf import PdfWriter
from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject

root = Path(__file__).resolve().parents[1] / 'docs' / 'assets'
root.mkdir(parents=True, exist_ok=True)

def create(name, title, subtitle, sections):
    writer = PdfWriter()
    page = writer.add_blank_page(width=612, height=792)
    fonts = DictionaryObject()
    for key, base in [('F1', 'Helvetica'), ('F2', 'Helvetica-Bold')]:
        fonts[NameObject('/'+key)] = writer._add_object(DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type1'),NameObject('/BaseFont'):NameObject('/'+base)}))
    page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'):fonts})
    ops = ['0.04 0.39 0.68 rg 48 730 516 4 re f']
    def text(x,y,size,value,font='F1',color='0.13 0.17 0.23'):
        value=value.replace('\\','\\\\').replace('(','\\(').replace(')','\\)')
        ops.append(f'{color} rg BT /{font} {size} Tf {x} {y} Td ({value}) Tj ET')
    text(48,750,10,'PDFreader / READING NOTES',color='0.04 0.39 0.68')
    text(48,690,27,title,'F2')
    text(48,662,12,subtitle,color='0.4 0.44 0.48')
    y=605
    for heading,lines in sections:
        text(48,y,16,heading,'F2');y-=31
        for line in lines:
            text(48,y,12,line);y-=22
        y-=27
    ops.append('0.85 0.88 0.91 RG 48 64 m 564 64 l S')
    text(48,43,9,'Original demonstration document. No private research material.',color='0.4 0.44 0.48')
    text(550,43,9,'01',color='0.04 0.39 0.68')
    stream=DecodedStreamObject();stream.set_data('\n'.join(ops).encode('ascii'))
    page[NameObject('/Contents')]=writer._add_object(stream)
    writer.add_outline_item('Reading note',0)
    writer.add_metadata({'/Title':title,'/Author':'MPomelo / PDFreader demo'})
    with (root/name).open('wb') as output:writer.write(output)

create('research-notes.pdf','Learning across domains','A short note on representation learning',[
    ('01  The domain shift problem',[
        'Domain adaptation transfers knowledge from a labeled source',
        'domain to an unlabeled target domain. The goal is to learn',
        'representations that remain useful when data distributions change.']),
    ('02  Learning a shared representation',[
        'A feature extractor encodes images into a shared space.',
        'A task classifier predicts labels, while a domain discriminator',
        'encourages features that reveal less about their domain.']),
    ('03  Reading questions',[
        'Which assumptions connect the source and target domains?',
        'How do confidence thresholds affect pseudo-label quality?',
        'Keep equations, citations, and original terminology in context.'])])
create('reading-workflow.pdf','A focused reading workflow','Read, annotate, translate, and keep your notes',[
    ('01  Read in parallel',[
        'Keep several PDFs open and switch between their tabs.',
        'Each document retains its page, zoom, annotations, and translation.']),
    ('02  Work with a passage',[
        'Select a paragraph, translate it, and compare with the original.',
        'Pin the result to the sidebar and resize it for longer equations.']),
    ('03  Keep the result',[
        'Export annotations to a new PDF and preserve the original.',
        'Save a translation note or export its original Markdown.'])])
print('Created two original showcase PDFs.')
