import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ARTICLE_URL = 'https://githubnext.com/posts/knowledge-compressor/';
const outputRoot = path.resolve(process.argv[2] ?? '.work/js-calibration/article');

const response = await fetch(ARTICLE_URL);
if (!response.ok) throw new Error(`Could not fetch ${ARTICLE_URL}: HTTP ${response.status}`);
const html = await response.text();
const articleMatch = html.match(/<article class="kc-replay-document">([\s\S]*?)<\/article>/);
if (!articleMatch) throw new Error('Could not find the Ferryline source article');
const source = decodeHtml(stripTags(articleMatch[1])).trim();
const questionColumn = html.match(/<div class="kc-replay-question-list">([\s\S]*?)<\/div>/);
if (!questionColumn) throw new Error('Could not find the article reference questions');
const questions = [...questionColumn[1].matchAll(/<details><summary>[\s\S]*?<\/span>([\s\S]*?)<\/summary><p><strong>Expected:<\/strong>\s*(?:<!-- -->)?\s*([\s\S]*?)<\/p><\/details>/g)].map((match, index) => ({
  index: index + 1,
  question: decodeHtml(stripTags(match[1])).trim(),
  answer: decodeHtml(stripTags(match[2])).trim(),
}));
if (questions.length !== 24) throw new Error(`Expected 24 reference questions, extracted ${questions.length}`);

const corpusDirectory = path.join(outputRoot, 'corpus');
const skillDirectory = path.join(outputRoot, 'skill');
await mkdir(corpusDirectory, { recursive: true });
await mkdir(skillDirectory, { recursive: true });
await writeFile(path.join(corpusDirectory, 'ferryline.md'), `# ${source}\n`, 'utf8');
await writeFile(path.join(outputRoot, 'reference-questions.json'), `${JSON.stringify({ sourceUrl: ARTICLE_URL, questions }, null, 2)}\n`, 'utf8');
await writeFile(path.join(skillDirectory, 'SKILL.md'), [
  '---',
  'name: ferryline-build-cache',
  'description: Use when answering questions about the synthetic Ferryline distributed build cache.',
  '---',
  '',
  `# ${source}`,
  '',
].join('\n'), 'utf8');
process.stdout.write(`${JSON.stringify({ corpusPath: corpusDirectory, questionCount: questions.length, referencePath: path.join(outputRoot, 'reference-questions.json'), skillPath: skillDirectory, sourceUrl: ARTICLE_URL })}\n`);

function stripTags(value) {
  return value.replace(/<!--.*?-->/gs, '').replace(/<[^>]+>/g, '');
}

function decodeHtml(value) {
  const named = { amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"' };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code) => {
    if (code.startsWith('#x')) return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
    if (code.startsWith('#')) return String.fromCodePoint(Number.parseInt(code.slice(1), 10));
    return named[code.toLowerCase()] ?? entity;
  });
}