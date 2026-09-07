import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { stableStringify } from './json.js';
import { InvalidStructuredResponse, parseJsonObject } from './structured.js';

export async function buildSkillAuditPrompt({ skillPath, question, source }) {
  const files = {};
  for (const filePath of await allFiles(path.resolve(skillPath))) {
    files[path.relative(skillPath, filePath).split(path.sep).join('/')] = await readFile(filePath, 'utf8');
  }
  return [
    'Audit whether the supplied skill contains the knowledge required to answer the question. Compare meaning, not exact wording. Return only JSON:',
    '{"present":true,"complete":true,"contradictory":false,"files":["SKILL.md"],"rationale":"..."}',
    'present means at least some required knowledge exists. complete means all required knowledge exists. contradictory means the skill conflicts with the supplied source. files must name only supplied files containing relevant text.',
    '',
    'INPUT:',
    stableStringify({ question, source, skillFiles: files }),
  ].join('\n');
}

export function parseSkillAudit(response) {
  const data = parseJsonObject(response);
  for (const field of ['present', 'complete', 'contradictory']) {
    if (typeof data[field] !== 'boolean') throw new InvalidStructuredResponse(`${field} must be a boolean`);
  }
  if (!Array.isArray(data.files) || data.files.some((file) => typeof file !== 'string')) throw new InvalidStructuredResponse('files must be an array of strings');
  if (typeof data.rationale !== 'string' || !data.rationale.trim()) throw new InvalidStructuredResponse('rationale must be a non-empty string');
  return { present: data.present, complete: data.complete, contradictory: data.contradictory, files: [...new Set(data.files.filter((file) => file.trim()))].sort(), rationale: data.rationale.trim() };
}

async function allFiles(root) {
  const files = [];
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await allFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}