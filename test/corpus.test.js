import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { afterEach, test } from 'node:test';

import { corpusRevision, globToRegExp, loadCorpus, splitDocument, splitSection } from '../src/corpus.js';

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

test('section labels point at the document, heading path and line range', () => {
  const content = '# Guide\n\nIntro line.\n\n## Setup\n\nInstall it.\n\n### Details\n\nMore.\n';
  const sections = splitDocument({ documentId: 'docs/guide.md', revision: 'r', content }, 12_000);
  assert.deepEqual(sections.map((section) => section.label), ['docs/guide.md › Guide (lines 1–3)', 'docs/guide.md › Guide › Setup (lines 5–7)', 'docs/guide.md › Guide › Setup › Details (lines 9–11)']);
  assert.deepEqual(sections[2].headingPath, ['Guide', 'Setup', 'Details']);
});

test('merges small adjacent sections but never across chapter headings, and joins heading-only sections forward', () => {
  const body = (word) => `${word} `.repeat(20).trim();
  const content = `# Title\n\n## One\n\n${body('Alpha')}.\n\n### A\n\n${body('Beta')}.\n\n### B\n\n${body('Gamma')}.\n\n## Two\n\n${body('Delta')}.\n`;
  const merged = splitDocument({ documentId: 'd.md', revision: 'r', content }, 12_000, 1500);
  assert.equal(merged.length, 2);
  assert.ok(merged[0].content.includes('# Title') && merged[0].content.includes('Gamma') && !merged[0].content.includes('Delta'));
  assert.match(merged[0].label, /^d\.md › Title \(\+3 more headings\) \(lines 1–\d+\)$/);
  assert.equal(content.slice(merged[0].start, merged[0].end).trim(), merged[0].content);
  assert.equal(splitDocument({ documentId: 'd.md', revision: 'r', content }, 12_000, 0).length, 5);
});

test('merging respects the maximum section size', () => {
  const paragraph = (name) => `### ${name}\n\n${'word '.repeat(150)}\n\n`;
  const content = `## Chapter\n\n${paragraph('A')}${paragraph('B')}${paragraph('C')}`;
  const sections = splitDocument({ documentId: 'd.md', revision: 'r', content }, 1_000, 5_000);
  assert.ok(sections.every((section) => section.content.length <= 1_000));
});

test('ignores headings inside fenced code blocks', () => {
  const content = '# Real\n\n```sh\n# a comment, not a heading\nrun\n```\n\n## Next\n\nText.\n';
  assert.deepEqual(splitDocument({ documentId: 'd.md', revision: 'r', content }).map((section) => section.heading), ['Real', 'Next']);
});

test('splitSection halves a section at the paragraph break nearest its middle and keeps provenance', () => {
  const first = `Alpha. ${'one '.repeat(100)}`;
  const second = `Beta. ${'two '.repeat(100)}`;
  const content = `# Big\n\n${first}\n\n${second}\n`;
  const document = { documentId: 'd.md', revision: 'r', content };
  const [section] = splitDocument(document);
  const parts = splitSection(section, document);
  assert.equal(parts.length, 2);
  assert.ok(parts[0].content.startsWith('# Big') && parts[0].content.includes('Alpha.') && !parts[0].content.includes('Beta.'));
  assert.ok(parts[1].content.startsWith('Beta.'));
  for (const part of parts) assert.equal(content.slice(part.start, part.end).trim(), part.content);
  assert.match(parts[1].sectionId, /~2$/);
  assert.match(parts[1].label, /part 2 of 2\)$/);
  assert.equal(splitSection({ ...section, content: 'tiny', start: 0, end: 4 }, document), undefined);
});

test('accepts a single Markdown file and include/exclude globs', async () => {
  await mkdir(`${root}/guides/internal`, { recursive: true });
  await writeFile(`${root}/guides/a.md`, '# A\n');
  await writeFile(`${root}/guides/internal/b.md`, '# B\n');
  await writeFile(`${root}/c.md`, '# C\n');
  assert.deepEqual((await loadCorpus(`${root}/c.md`)).map((document) => document.documentId), ['c.md']);
  assert.deepEqual((await loadCorpus(root, { include: ['guides/**'] })).map((document) => document.documentId), ['guides/a.md', 'guides/internal/b.md']);
  assert.deepEqual((await loadCorpus(root, { exclude: ['**/internal/**', 'c.md'] })).map((document) => document.documentId), ['guides/a.md']);
  await assert.rejects(loadCorpus(root, { include: ['nothing/**'] }), /contains no Markdown files/);
  assert.ok(globToRegExp('docs/*.md').test('docs/a.md') && !globToRegExp('docs/*.md').test('docs/x/a.md'));
});

test('rejects missing and empty corpora', async () => {
  await assert.rejects(loadCorpus(root), /does not exist/);
  await mkdir(root, { recursive: true });
  await assert.rejects(loadCorpus(root), /contains no Markdown files/);
});