import { UsageError } from './errors.js';

export const FILTER_KEYS = ['type', 'difficulty', 'importance', 'document', 'section'];
const IMPORTANCE_ORDER = { low: 1, medium: 2, high: 3 };

// Maps each section id to its document and the nearest preceding markdown heading, derived from evidence offsets.
export function buildSectionIndex({ evidence = [], documents = {} }) {
  const index = new Map();
  for (const item of evidence) {
    if (!item.sectionId) continue;
    const existing = index.get(item.sectionId);
    if (existing && existing.start <= (item.start ?? Infinity)) continue;
    index.set(item.sectionId, { documentId: item.documentId, heading: headingBefore(documents[item.documentId], item.start), start: item.start ?? Infinity });
  }
  return new Map([...index].map(([id, section]) => [id, { sectionId: id, documentId: section.documentId, heading: section.heading, label: section.heading ?? shortId(id), start: Number.isFinite(section.start) ? section.start : null }]));
}

function headingBefore(content, offset) {
  if (typeof content !== 'string' || !Number.isInteger(offset)) return undefined;
  const lineEnd = content.indexOf('\n', offset);
  const text = lineEnd === -1 ? content : content.slice(0, lineEnd);
  let heading;
  for (const match of text.matchAll(/^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm)) heading = match[1].trim();
  return heading;
}

export function shortId(id) {
  return String(id).replace(/^[a-z]+_/, '').slice(0, 8);
}

export function parseFilter(expression) {
  if (expression === undefined || expression === null || expression === '') return [];
  return String(expression).split(',').map((part) => {
    const separator = part.indexOf('=');
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (separator < 1 || !value) throw new UsageError(`Invalid --filter term ${JSON.stringify(part)}. Expected key=value.`);
    if (!FILTER_KEYS.includes(key)) throw new UsageError(`Unknown --filter key ${JSON.stringify(key)}. Valid keys: ${FILTER_KEYS.join(', ')}.`);
    if (key === 'importance' && !(value in IMPORTANCE_ORDER)) throw new UsageError(`Invalid importance ${JSON.stringify(value)}. Valid values: ${Object.keys(IMPORTANCE_ORDER).join(', ')}.`);
    return { key, value };
  });
}

// Highest importance among the knowledge items a question's rubric maps to.
export function questionImportance(question, knowledgeById) {
  let best;
  for (const criterion of question.rubric ?? []) {
    for (const id of criterion.knowledgeItemIds ?? []) {
      const importance = knowledgeById.get(id)?.importance;
      if ((IMPORTANCE_ORDER[importance] ?? 0) > (IMPORTANCE_ORDER[best] ?? 0)) best = importance;
    }
  }
  return best;
}

// Section ids a question's evidence belongs to.
export function questionSections(question, evidenceById) {
  return [...new Set(question.evidenceIds.map((id) => evidenceById.get(id)?.sectionId).filter(Boolean))];
}

export function questionDocuments(question, evidenceById) {
  return [...new Set(question.evidenceIds.map((id) => evidenceById.get(id)?.documentId).filter(Boolean))];
}

export function filterQuestions({ questions, terms, knowledge = [], evidence = [], documents = {} }) {
  if (!terms.length) return questions;
  const knowledgeById = new Map(knowledge.map((item) => [item.knowledgeId, item]));
  const evidenceById = new Map(evidence.map((item) => [item.evidenceId, item]));
  const sections = buildSectionIndex({ evidence, documents });
  const byKey = new Map();
  for (const term of terms) byKey.set(term.key, [...(byKey.get(term.key) ?? []), term.value]);
  const matchers = {
    type: (question, value) => question.questionType === value,
    difficulty: (question, value) => question.difficulty === value,
    importance: (question, value) => questionImportance(question, knowledgeById) === value,
    document: (question, value) => questionDocuments(question, evidenceById).some((id) => id === value || id.endsWith(`/${value}`)),
    section: (question, value) => questionSections(question, evidenceById).some((id) => id.startsWith(value) || (sections.get(id)?.heading ?? '').toLowerCase().includes(value.toLowerCase())),
  };
  // Different keys combine with AND; repeated values for one key combine with OR.
  return questions.filter((question) => [...byKey].every(([key, values]) => values.some((value) => matchers[key](question, value))));
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

// Deterministic sample stratified by question type: proportional allocation with at least one per type when n allows.
export function sampleQuestions(questions, n, seed = 0) {
  if (!Number.isInteger(n) || n < 1) throw new UsageError('--sample must be a positive integer.');
  if (n >= questions.length) return questions;
  const groups = new Map();
  for (const question of [...questions].sort((left, right) => left.testId.localeCompare(right.testId, 'en'))) {
    groups.set(question.questionType, [...(groups.get(question.questionType) ?? []), question]);
  }
  const types = [...groups.keys()].sort();
  const sizes = types.map((type) => groups.get(type).length);
  const ideal = sizes.map((size) => n * size / questions.length);
  const floor = n >= types.length ? 1 : 0;
  const allocation = ideal.map((value, position) => Math.min(sizes[position], Math.max(floor, Math.floor(value))));
  const total = () => allocation.reduce((sum, value) => sum + value, 0);
  const positions = types.map((_, position) => position);
  while (total() < n) {
    const candidates = positions.filter((position) => allocation[position] < sizes[position]);
    candidates.sort((left, right) => (ideal[right] - allocation[right]) - (ideal[left] - allocation[left]) || left - right);
    allocation[candidates[0]] += 1;
  }
  while (total() > n) {
    const candidates = positions.filter((position) => allocation[position] > floor);
    candidates.sort((left, right) => (allocation[right] - ideal[right]) - (allocation[left] - ideal[left]) || right - left);
    allocation[candidates[0]] -= 1;
  }
  const random = mulberry32(seed);
  const chosen = new Set();
  types.forEach((type, position) => {
    const group = [...groups.get(type)];
    for (let index = group.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(random() * (index + 1));
      [group[index], group[swap]] = [group[swap], group[index]];
    }
    for (const question of group.slice(0, allocation[position])) chosen.add(question.testId);
  });
  return questions.filter((question) => chosen.has(question.testId));
}

// Applies --filter then --sample; the result keeps dataset order.
export function selectQuestions({ questions, knowledge, evidence, documents, filter, sample, seed }) {
  const terms = parseFilter(filter);
  let selected = filterQuestions({ questions, terms, knowledge, evidence, documents });
  if (!selected.length) throw new UsageError(`--filter ${JSON.stringify(filter)} matched no questions.`);
  if (sample !== undefined) selected = sampleQuestions(selected, sample, seed ?? 0);
  return { questions: selected, partial: selected.length < questions.length, filter: terms.length ? filter : undefined, sample: sample === undefined ? undefined : { n: sample, seed: seed ?? 0 } };
}
