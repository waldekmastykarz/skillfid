import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const HEADING_PATTERN = /^(#{1,6})\s+(.+?)\s*$/gm;

export async function loadCorpus(corpusPath) {
  const root = path.resolve(corpusPath);
  let entries;
  try {
    entries = await markdownFiles(root);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      throw new Error(`Corpus directory does not exist: ${corpusPath}`);
    }
    throw error;
  }

  if (entries.length === 0) {
    throw new Error(`Corpus contains no Markdown files: ${corpusPath}`);
  }

  return Promise.all(entries.map(async (filePath) => {
    const content = normalizeText(await readFile(filePath, 'utf8'));
    return {
      documentId: path.relative(root, filePath).split(path.sep).join('/'),
      path: filePath,
      revision: sha256(content),
      content,
    };
  }));
}

export function splitDocument(document, maxChars = 12_000) {
  if (maxChars < 500) {
    throw new Error('maxChars must be at least 500');
  }

  const boundaries = [0];
  for (const match of document.content.matchAll(HEADING_PATTERN)) {
    if (match.index > 0) boundaries.push(match.index);
  }
  boundaries.push(document.content.length);

  const sections = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    const rawSection = document.content.slice(start, end);
    if (!rawSection.trim()) continue;
    HEADING_PATTERN.lastIndex = 0;
    const headingMatch = HEADING_PATTERN.exec(rawSection);
    const heading = headingMatch ? headingMatch[2].trim() : 'Preamble';
    for (const [chunkStart, chunkEnd] of chunkBounds(rawSection, maxChars)) {
      const absoluteStart = start + chunkStart;
      const absoluteEnd = start + chunkEnd;
      const content = document.content.slice(absoluteStart, absoluteEnd).trim();
      if (!content) continue;
      const sectionKey = `${document.documentId}:${absoluteStart}:${absoluteEnd}`;
      sections.push({
        sectionId: `sec_${sha256(sectionKey).slice(0, 16)}`,
        documentId: document.documentId,
        heading,
        content,
        start: absoluteStart,
        end: absoluteEnd,
      });
    }
  }
  return sections;
}

export function corpusRevision(documents) {
  return sha256(documents.map((document) => `${document.documentId}:${document.revision}`).join('\n'));
}

async function markdownFiles(root) {
  const files = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await markdownFiles(entryPath));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(entryPath);
  }
  return files;
}

function chunkBounds(content, maxChars) {
  const bounds = [];
  let start = 0;
  while (start < content.length) {
    const targetEnd = Math.min(start + maxChars, content.length);
    let end = targetEnd;
    if (targetEnd < content.length) {
      const paragraphBreak = content.lastIndexOf('\n\n', targetEnd - 1);
      const lineBreak = content.lastIndexOf('\n', targetEnd - 1);
      const candidate = Math.max(paragraphBreak + 2, lineBreak + 1);
      if (candidate > start) end = candidate;
    }
    bounds.push([start, end]);
    start = end;
  }
  return bounds;
}

function normalizeText(content) {
  return `${content.replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim()}\n`;
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}