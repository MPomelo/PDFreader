const ligatures = { '\uFB00': 'ff', '\uFB01': 'fi', '\uFB02': 'fl', '\uFB03': 'ffi', '\uFB04': 'ffl', '\uFB05': 'st', '\uFB06': 'st' };

export function expandLigatures(text) {
  return text.replace(/[\uFB00-\uFB06]/g, character => ligatures[character]);
}

// Clean PDF layout whitespace without applying NFKC to mathematical notation.
// Blank lines remain paragraph boundaries; single line breaks are layout wraps.
export function normalizeSelectionText(text) {
  return expandLigatures(text)
    .replace(/\r\n?/g, '\n')
    // A discretionary hyphen is not part of the word, including at a wrap.
    .replace(/\u00AD[\t \u00A0]*\n[\t \u00A0]*(?=\S)/g, '')
    .replace(/\u00AD/g, '')
    .split(/\n[\t \u00A0]*\n+/)
    .map(paragraph => paragraph
      .replace(/[^\S\n]+/gu, ' ')
      // Keep explicit compound-word hyphens; do not guess word spellings.
      .replace(/([\p{L}\p{N}])[-\u2010] *\n *(?=[\p{L}\p{N}])/gu, '$1-')
      .replace(/([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]) *\n *(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])/gu, '$1')
      .replace(/ *\n */g, ' ')
      .trim())
    .filter(Boolean)
    .join('\n\n');
}
