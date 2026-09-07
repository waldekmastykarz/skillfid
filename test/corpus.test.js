import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { afterEach, test } from 'node:test';

import { corpusRevision, loadCorpus, splitDocument } from '../src/corpus.js';

const root = '.work/js-tests/corpus';

afterEach(async () => rm(root, { recursive: true, force: true }));

test('loads Markdown recursively in stable order and normalizes text', async () => {
  await mkdir(`${root}/nested`, { recursive: true });
  await writeFile(`${root}/z.md`, '# Z\r\n\r\nLast');
  await writeFile(`${root}/nested/a.md`, '# A\n\nFirst\n\n');
  await writeFile(`${root}/ignored.txt`, 'ignored');

  const documents = await loadCorpus(root);

  assert.deepEqual(documents.map((document) => document.documentId), ['nested/a.md', 'z.md']);
  assert.equal(documents[1].content, '# Z\n\nLast\n');
  assert.match(corpusRevision(documents), /^[a-f0-9]{64}$/);
});

test('splits headings and preserves source offsets', () => {
  const content = '# First\n\nAlpha\n\n## Second\n\nBeta\n';
  const document = { documentId: 'doc.md', revision: 'revision', content };

  const sections = splitDocument(document);

  assert.deepEqual(sections.map((section) => section.heading), ['First', 'Second']);
  assert.equal(content.slice(sections[1].start, sections[1].end).trim(), sections[1].content);
});

test('rejects missing and empty corpora', async () => {
  await assert.rejects(loadCorpus(root), /does not exist/);
  await mkdir(root, { recursive: true });
  await assert.rejects(loadCorpus(root), /contains no Markdown files/);
});