export const FORMATS = ['APA 7', 'IEEE', 'GB/T 7714', 'BibTeX'] as const;
export type CitationFormat = typeof FORMATS[number];
export type CitationKind = 'article' | 'conference' | 'book' | 'report' | '';
export type CitationData = {
  title: string; authors: string; year: string; container: string; publisher: string;
  volume: string; issue: string; pages: string; doi: string; url: string; kind: CitationKind;
};
export type CitationMetadata = CitationData & { inferredTitle: boolean; inferredDOI: boolean };
export const EMPTY_CITATION: CitationData = {
  title: '', authors: '', year: '', container: '', publisher: '', volume: '', issue: '', pages: '', doi: '', url: '', kind: '',
};

const join = (values: string[], separator = ', ') => values.filter(Boolean).join(separator);
const period = (value: string) => !value || /[.?!。！？]$/u.test(value) ? value : value + '.';
const nameParts = (name: string) => {
  if (/[^\p{Script=Latin}\p{M}\s.,'’\-]/u.test(name) || /^\{.+\}$/u.test(name)) return { family: name.replace(/^\{|\}$/g, ''), initials: '' };
  const inverted = /^([^,]+),\s*(.+)$/u.exec(name);
  const natural = /^(.+?)\s+(\S+)$/u.exec(name);
  const family = inverted?.[1] || natural?.[2] || name;
  const given = inverted?.[2] || natural?.[1] || '';
  const initials = (given.match(/(?:^|[\s-])\p{L}/gu) || []).map(letter => letter.trimStart().toUpperCase() + '.').join(' ').replace(/ -/g, '-');
  return { family, initials };
};
const relatedURL = (link: string) => {
  try { const result = new URL(link); return /^https?:$/u.test(result.protocol) ? result.href : ''; } catch { return ''; }
};
function bibEscape(value: string) {
  const special: Record<string, string> = { '\\': '\\textbackslash{}', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}' };
  return value.replace(/[\\{}%&_$#~^]/gu, character => special[character] || '\\' + character);
}

export function formatCitation(data: CitationData, format: CitationFormat): string {
  const { title, year, kind, container, publisher, volume, issue, pages, doi, url } = data;
  if (!title) return '';
  const authors = data.authors.split(/[;；\n]+/u).map(name => name.trim()).filter(Boolean);
  const names = authors.map(nameParts);
  const doiURL = doi ? 'https://doi.org/' + doi : '';
  const link = doiURL || relatedURL(url);
  const venue = kind === 'conference' || kind === 'article' ? container : publisher || container;
  const pageLabel = pages.includes('–') || pages.includes('-') ? 'pp. ' : 'p. ';
  if (format === 'BibTeX') {
    const entry = { article: 'article', conference: 'inproceedings', book: 'book', report: 'techreport', '': 'misc' }[kind];
    const lead = names[0]?.family.toLowerCase().normalize('NFD').replace(/[^a-z]/g, '') || 'reference';
    const keyword = title.toLowerCase().match(/[a-z]{3,}/u)?.[0] || '';
    const fields = { author: authors.map(name => /^\{.+\}$/u.test(name) ? '{' + bibEscape(name.slice(1, -1)) + '}' : bibEscape(name)).join(' and '),
      title: bibEscape(title), year, ...(kind === 'article' ? { journal: bibEscape(container), volume: bibEscape(volume), number: bibEscape(issue) } : {}),
      ...(kind === 'conference' ? { booktitle: bibEscape(container) } : {}),
      ...(!kind ? { howpublished: bibEscape(container) } : {}),
      ...(kind === 'report' ? { institution: bibEscape(venue) } : { publisher: kind === 'article' ? '' : bibEscape(publisher) }),
      pages: bibEscape(pages.replace(/\s*[–—-]+\s*/gu, '--')), doi: bibEscape(doi), url: bibEscape(relatedURL(url)) };
    return `@${entry}{${lead}${year}${keyword},\n${Object.entries(fields).filter(([, value]) => value)
      .map(([field, value]) => `  ${field} = {${value}}`).join(',\n')}\n}`;
  }
  if (format === 'APA 7') {
    const formatted = names.map(({ family, initials }) => join([family, initials]));
    const author = formatted.length > 20 ? [...formatted.slice(0, 19), '… ' + formatted.at(-1)].join(', ') :
      formatted.length > 1 ? formatted.slice(0, -1).join(', ') + ', & ' + formatted.at(-1) : formatted[0] || '';
    const date = `(${year || 'n.d.'}).`;
    const source = kind === 'article' ? join([venue, volume + (issue ? `(${issue})` : ''), pages]) :
      kind === 'conference' ? join([venue && 'In ' + venue, pages && `(${pageLabel}${pages})`, publisher]) : venue;
    return join([author ? join([period(author), date, period(title)], ' ') : join([period(title), date], ' '), period(source), link], ' ');
  }
  if (format === 'IEEE') {
    const formatted = names.map(({ family, initials }) => join([initials, family], ' '));
    const author = formatted.length > 6 ? formatted[0] + ' et al.' : formatted.length > 1 ?
      formatted.slice(0, -1).join(', ') + (formatted.length > 2 ? ', and ' : ' and ') + formatted.at(-1) : formatted[0] || '';
    const details = join([kind === 'conference' && venue ? 'in ' + venue : venue, volume && 'vol. ' + volume,
      issue && 'no. ' + issue, pages && pageLabel + pages, year, doi ? 'doi: ' + doi : link]);
    if (kind === 'book') return period(join([author, title, details]));
    return join([author && author + ',', `“${title.replace(/[.,]$/u, '')}${details ? ',' : '.'}”`, period(details)], ' ');
  }
  const code = { article: 'J', conference: 'C', book: 'M', report: 'R', '': 'Z' }[kind];
  const chinese = /\p{Script=Han}/u.test(title);
  const author = names.slice(0, 3).map(({ family, initials }) => join([family.toUpperCase(), initials.replace(/[.]/g, '')], ' ')).join(', ') +
    (names.length > 3 ? (chinese ? ', 等' : ', et al.') : '');
  const serial = join([venue, year, volume + (issue ? `(${issue})` : '')]);
  const location = serial && pages ? `${serial}: ${pages}` : serial || pages;
  return join([period(author), period(`${title.replace(/[.。]$/u, '')}[${code}]`), period(location), doi ? period(`DOI:${doi}`) : link], ' ');
}
