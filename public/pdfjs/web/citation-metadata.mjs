const doiPattern = /10\.\d{4,9}\/[\p{L}\d_.;()/:+%\-]+/giu;

function findDOIs(text) {
  return [...new Set((text.match(doiPattern) || []).map(value => {
    let doi = value.replace(/[.,;:]+$/u, '');
    while (doi.endsWith(')') && doi.split(')').length > doi.split('(').length) doi = doi.slice(0, -1);
    return doi.toLowerCase();
  }))];
}

function pageTitle(content, viewport) {
  const lines = content.items.flatMap(item => {
    if (!item.str?.trim() || !item.height || Math.abs(item.transform[1]) > 0.1) return [];
    const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
    return y > viewport.height * 0.04 && y < viewport.height * 0.30 ? [{ ...item, x, y }] : [];
  });
  const lead = lines.filter(line => line.width > viewport.width * 0.27 && line.str.trim().length >= 12)
    .sort((a, b) => b.height - a.height || a.y - b.y)[0];
  if (!lead || lead.height < viewport.height * 0.014) return '';
  const center = lead.x + lead.width / 2;
  return lines.filter(line => Math.abs(line.y - lead.y) < lead.height * 2.8 &&
    line.height >= lead.height * 0.92 && Math.abs(line.x + line.width / 2 - center) < viewport.width * 0.13)
    .sort((a, b) => a.y - b.y || a.x - b.x).map(line => line.str.trim()).join(' ');
}

export async function readCitationMetadata(pdf) {
  const [{ info, metadata }, first] = await Promise.all([
    pdf.getMetadata().catch(() => ({})), pdf.getPage(1).catch(() => null),
  ]);
  const raw = metadata?.getRaw();
  const xml = raw?.length < 250000 ? new DOMParser().parseFromString(raw, 'application/xml') : null;
  const descriptions = Array.from(xml?.getElementsByTagNameNS('http://www.w3.org/1999/02/22-rdf-syntax-ns#', 'Description') || []);
  const clean = value => typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, 1000) : '';
  const prism = (name) => clean(metadata?.get('prism:' + name.toLowerCase()) || descriptions.flatMap(node =>
    Array.from(node.attributes).filter(attr => attr.localName === name && attr.namespaceURI?.includes('prismstandard.org')).map(attr => attr.value)
  )[0]);
  let title = clean(xml?.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'title')[0]
    ?.getElementsByTagNameNS('http://www.w3.org/1999/02/22-rdf-syntax-ns#', 'li')[0]?.textContent || metadata?.get('dc:title') || info?.Title);
  if (/^(?:untitled|无标题|microsoft word)(?:$|\s+-)/iu.test(title)) title = '';
  const creators = metadata?.get('dc:creator');
  const authors = (Array.isArray(creators) && creators.length ? creators : (info?.Author || '').split(/[;\n；]+/u)).map(clean).filter(Boolean).join('\n');
  // PDF creation and modification dates describe the file itself.
  const year = /^(\d{4})(?:[-/]|$)/u.exec(prism('publicationDate') || prism('coverDate'))?.[1] || '';
  const container = prism('publicationName');
  const publisher = clean(metadata?.get('dc:publisher'));
  let doi = findDOIs([prism('doi'), clean(metadata?.get('dc:identifier')), clean(info?.Custom?.DOI)].join(' '))[0] || '';
  let inferredTitle = false, inferredDOI = false;
  if (first && (!title || !doi)) {
    const content = await first.getTextContent().catch(() => null);
    if (content) {
      if (!title) {
        title = clean(pageTitle(content, first.getViewport({ scale: 1, rotation: 0 })));
        inferredTitle = Boolean(title);
      }
      const text = content.items.map(item => item.str || '').join(' ');
      const printed = [...text.matchAll(/(?:\bdoi\s*:\s*|https?:\/\/(?:dx\.)?doi\.org\/)(10\.\d{4,9}\/[^\s<>]+)/giu)].map(match => match[1]);
      const candidates = findDOIs(printed.join(' '));
      if (!doi && candidates.length === 1) {
        doi = candidates[0];
        inferredDOI = true;
      }
    }
  }
  const start = prism('startingPage'), end = prism('endingPage');
  const volume = prism('volume'), issue = prism('number');
  const kind = volume || issue || /journal/.test(prism('aggregationType').toLowerCase()) ? 'article' :
    /conference|proceedings/.test(prism('aggregationType').toLowerCase()) ? 'conference' : '';
  return { title, authors, year, container, publisher, volume, issue, pages: prism('pageRange') || [start, end === start ? '' : end].filter(Boolean).join('–'),
    doi, url: prism('url'), kind, inferredTitle, inferredDOI };
}
