import { createHash } from 'node:crypto';

import { InvalidStructuredResponse, parseJsonObject } from './structured.js';
import { stableStringify } from './json.js';

export const KNOWLEDGE_KINDS = new Set(['fact', 'rule', 'procedure', 'constraint', 'exception', 'warning', 'default', 'relationship', 'trend']);
export const IMPORTANCE_LEVELS = new Set(['high', 'medium', 'low']);

export function buildInventoryPrompt(section, existingItems = []) {
  const existing = existingItems.map(({ knowledgeId, kind, statement }) => ({ knowledgeId, kind, statement }));
  const classificationInstruction = existingItems.length
    ? 'For this residual pass, classification describes whether missing testable knowledge remains. Return non_informational with an empty items array when the existing inventory already covers the section. Do not return paraphrases or alternate classifications of existing items.'
    : 'Return non_informational with an empty items array only when the section contains no testable knowledge.';
  return [
    'Inventory every independently testable piece of knowledge in the source section. Include facts, rules, procedures, constraints, exceptions, warnings, defaults, relationships, and trends. Do not summarize multiple distinct items into one. If existing items are supplied, return only substantive items they missed.',
    '',
    'Return only one JSON object with this shape:',
    '{"classification":"informational","reason":"...","items":[{"kind":"rule","statement":"...","importance":"high","importanceReason":"...","quote":"exact unique source quote"}]}',
    'classification must be informational or non_informational. kind must be one of: fact, rule, procedure, constraint, exception, warning, default, relationship, or trend.',
    classificationInstruction,
    'Every quote must appear exactly once in the supplied section and fully support the statement. Importance must be high, medium, or low.',
    '',
    `SECTION ID: ${section.sectionId}`,
    `HEADING: ${section.heading}`,
    'EXISTING ITEMS:',
    stableStringify(existing),
    'SOURCE SECTION:',
    section.content,
  ].join('\n');
}

export function parseInventoryResponse(response, { section, document }) {
  const data = parseJsonObject(response);
  if (!['informational', 'non_informational'].includes(data.classification)) throw new InvalidStructuredResponse('classification must be informational or non_informational');
  const reason = requiredString(data, 'reason');
  if (!Array.isArray(data.items)) throw new InvalidStructuredResponse('items must be an array');
  if (data.classification === 'non_informational' && data.items.length) throw new InvalidStructuredResponse('A non_informational section must have an empty items array');
  if (data.classification === 'informational' && !data.items.length) throw new InvalidStructuredResponse('An informational section must contain at least one item');

  const items = [];
  const evidence = [];
  const statements = new Set();
  for (const rawItem of data.items) {
    if (rawItem === null || Array.isArray(rawItem) || typeof rawItem !== 'object') throw new InvalidStructuredResponse('Each inventory item must be an object');
    const kind = requiredString(rawItem, 'kind');
    const statement = requiredString(rawItem, 'statement');
    const importance = requiredString(rawItem, 'importance');
    const importanceReason = requiredString(rawItem, 'importanceReason');
    const quote = requiredString(rawItem, 'quote');
    if (!KNOWLEDGE_KINDS.has(kind)) throw new InvalidStructuredResponse(`Unsupported knowledge kind: ${kind}`);
    if (!IMPORTANCE_LEVELS.has(importance)) throw new InvalidStructuredResponse(`Unsupported importance: ${importance}`);
    if (statements.has(statement)) throw new InvalidStructuredResponse(`Duplicate knowledge statement: ${statement}`);
    if (findAll(section.content, quote).length !== 1) throw new InvalidStructuredResponse(`Evidence quote must occur exactly once in section: ${JSON.stringify(quote)}`);
    const start = document.content.indexOf(quote, section.start);
    if (start < 0 || start >= section.end) throw new InvalidStructuredResponse(`Evidence quote could not be located in document: ${JSON.stringify(quote)}`);
    const end = start + quote.length;
    const evidenceId = `ev_${digest(`${document.revision}:${start}:${end}:${quote}`).slice(0, 16)}`;
    const knowledgeId = `ki_${digest(`${kind}:${statement}:${evidenceId}`).slice(0, 16)}`;
    evidence.push({ evidenceId, documentId: document.documentId, revision: document.revision, sectionId: section.sectionId, quote, start, end });
    items.push({ knowledgeId, sectionId: section.sectionId, kind, statement, importance, importanceReason, evidenceIds: [evidenceId] });
    statements.add(statement);
  }
  return { sectionId: section.sectionId, classification: data.classification, reason, items, evidence };
}

export function requiredString(value, key) {
  if (typeof value[key] !== 'string' || !value[key].trim()) throw new InvalidStructuredResponse(`${key} must be a non-empty string`);
  return value[key].trim();
}

function findAll(content, value) {
  const matches = [];
  for (let start = 0; ; start += 1) {
    const match = content.indexOf(value, start);
    if (match < 0) return matches;
    matches.push(match);
    start = match;
  }
}

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}