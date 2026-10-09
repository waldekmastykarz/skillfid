import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const HEADING_PATTERN = /^(#{1,6})\s+(.+?)\s*$/gm;
const FENCE_PATTERN = /^(```|~~~)/;
// Sections are never merged across headings at or above this level, so a merged unit stays inside one chapter.
const MERGE_BOUNDARY_LEVEL = 2;
const HEADING_ONLY_CHARS = 40;

export async function loadCorpus(corpusPath, { include = [], exclude = [] } = {}) {
  const target = path.resolve(corpusPath);
  let root = target;
  let entries;
  try {
    if ((await stat(target)).isFile()) {
      if (!target.endsWith('.md')) throw new Error(`Corpus file is not Markdown: ${corpusPath}`);
      root = path.dirname(target);
      entries = [target];
    } else entries = await markdownFiles(target);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      throw new Error(`Corpus directory does not exist: ${corpusPath}`);
    }
    throw error;
  }

  const includes = include.map(globToRegExp);
  const excludes = exclude.map(globToRegExp);
  entries = entries.filter((filePath) => {
    const documentId = path.relative(root, filePath).split(path.sep).join('/');
    return (!includes.length || includes.some((pattern) => pattern.test(documentId))) && !excludes.some((pattern) => pattern.test(documentId));
  });

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

export function globToRegExp(glob) {
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*' && glob[index + 1] === '*') {
      if (glob[index + 2] === '/') { source += '(?:.*/)?'; index += 2; }
      else { source += '.*'; index += 1; }
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

export function splitDocument(document, maxChars = 12_000, minChars = 0) {
  if (maxChars < 500) {
    throw new Error('maxChars must be at least 500');
  }

  const headings = documentHeadings(document.content);
  const boundaries = [0];
  for (const heading of headings) if (heading.index > 0) boundaries.push(heading.index);
  boundaries.push(document.content.length);

  const units = [];
  const stack = [];
  let headingIndex = 0;
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    const rawSection = document.content.slice(start, end);
    if (!rawSection.trim()) continue;
    let heading = 'Preamble';
    let level = 0;
    if (headings[headingIndex]?.index === start) {
      const current = headings[headingIndex];
      headingIndex += 1;
      heading = current.title;
      level = current.level;
      while (stack.length && stack.at(-1).level >= level) stack.pop();
      stack.push(current);
    }
    const headingPath = stack.map((item) => item.title);
    for (const [chunkStart, chunkEnd] of chunkBounds(rawSection, maxChars)) {
      if (!document.content.slice(start + chunkStart, start + chunkEnd).trim()) continue;
      units.push({ start: start + chunkStart, end: start + chunkEnd, heading, level, headingPath: [...headingPath], headings: [heading] });
    }
  }

  return mergeSmallUnits(units, document, maxChars, minChars).map((unit) => buildSection(document, unit));
}

function mergeSmallUnits(units, document, maxChars, minChars) {
  if (minChars <= 0) return units;
  const merged = [];
  for (const unit of units) {
    const previous = merged.at(-1);
    const previousSize = previous ? document.content.slice(previous.start, previous.end).trim().length : 0;
    const unitSize = document.content.slice(unit.start, unit.end).trim().length;
    const crossesBoundary = unit.level > 0 && unit.level <= MERGE_BOUNDARY_LEVEL;
    // A heading with almost no text of its own always joins what follows, even across a chapter boundary.
    const headingOnly = previous && bodyChars(document.content.slice(previous.start, previous.end)) < HEADING_ONLY_CHARS;
    if (previous && (headingOnly || (previousSize < minChars && !crossesBoundary)) && previousSize + unitSize <= maxChars) {
      previous.end = unit.end;
      previous.headings.push(...unit.headings);
    } else merged.push({ ...unit, headings: [...unit.headings] });
  }
  return merged;
}

function bodyChars(text) {
  return text.split('\n').filter((line) => line.trim() && !/^#{1,6}\s/.test(line)).join('').length;
}

function buildSection(document, unit) {
  const content = document.content.slice(unit.start, unit.end).trim();
  const contentStart = unit.start + (document.content.slice(unit.start, unit.end).length - document.content.slice(unit.start, unit.end).trimStart().length);
  const lineStart = lineNumber(document.content, contentStart);
  const lineEnd = lineNumber(document.content, contentStart + Math.max(0, content.length - 1));
  const base = unit.headingPath.length ? unit.headingPath.join(' › ') : unit.heading;
  const extra = unit.headings.length > 1 ? ` (+${unit.headings.length - 1} more heading${unit.headings.length === 2 ? '' : 's'})` : '';
  const sectionKey = `${document.documentId}:${unit.start}:${unit.end}`;
  return {
    sectionId: `sec_${sha256(sectionKey).slice(0, 16)}`,
    documentId: document.documentId,
    heading: unit.heading,
    headingPath: unit.headingPath,
    label: `${document.documentId} › ${base}${extra} (lines ${lineStart}–${lineEnd})`,
    content,
    start: unit.start,
    end: unit.end,
  };
}

// Splits one section into two parts at the paragraph break nearest its middle; returns undefined when it cannot be split.
export function splitSection(section, document) {
  const text = section.content;
  const middle = Math.floor(text.length / 2);
  const candidates = [];
  for (let index = text.indexOf('\n\n'); index >= 0; index = text.indexOf('\n\n', index + 2)) candidates.push(index + 2);
  if (!candidates.length) for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) candidates.push(index + 1);
  const cut = candidates.filter((index) => index > 200 && text.length - index > 200).sort((left, right) => Math.abs(left - middle) - Math.abs(right - middle))[0];
  if (cut === undefined) return undefined;
  const origin = document.content.indexOf(text, section.start);
  if (origin < 0) return undefined;
  return [[0, cut], [cut, text.length]].map(([from, to], index) => {
    const content = text.slice(from, to).trim();
    const start = origin + from + (text.slice(from, to).length - text.slice(from, to).trimStart().length);
    const lineStart = lineNumber(document.content, start);
    const lineEnd = lineNumber(document.content, start + Math.max(0, content.length - 1));
    return {
      ...section,
      sectionId: `${section.sectionId}~${index + 1}`,
      label: `${section.label.replace(/ \(lines \d+–\d+\)$/, '')} (lines ${lineStart}–${lineEnd}, part ${index + 1} of 2)`,
      content,
      start: origin + from,
      end: origin + to,
    };
  });
}

function lineNumber(content, offset) {
  let line = 1;
  for (let index = content.indexOf('\n'); index >= 0 && index < offset; index = content.indexOf('\n', index + 1)) line += 1;
  return line;
}

// Headings inside fenced code blocks are code comments, not structure.
function documentHeadings(content) {
  const fenced = [];
  let fenceStart;
  let offset = 0;
  for (const line of content.split('\n')) {
    if (FENCE_PATTERN.test(line.trimStart())) {
      if (fenceStart === undefined) fenceStart = offset;
      else { fenced.push([fenceStart, offset + line.length]); fenceStart = undefined; }
    }
    offset += line.length + 1;
  }
  if (fenceStart !== undefined) fenced.push([fenceStart, content.length]);
  return [...content.matchAll(HEADING_PATTERN)]
    .filter((match) => !fenced.some(([from, to]) => match.index >= from && match.index <= to))
    .map((match) => ({ index: match.index, level: match[1].length, title: match[2].trim() }));
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
