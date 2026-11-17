// PDF.js resetModified() means serialized, not durably saved. Track that separately.
export class ExportState {
  revision = 0;
  #current = '';
  #saved = '';
  constructor(initialHash = '') { this.#current = this.#saved = initialHash; }
  observe(hash) {
    if (hash !== this.#current) { this.#current = hash; ++this.revision; }
    return this.dirty;
  }
  get dirty() { return this.#current !== this.#saved; }
  snapshot() { return { revision: this.revision, hash: this.#current }; }
  acknowledge(snapshot) {
    this.#saved = snapshot.hash;
    return !this.dirty;
  }
}
