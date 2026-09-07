import { stableStringify } from './json.js';
import { InvalidStructuredResponse, parseJsonObject } from './structured.js';

const BOOLEAN_FIELDS = ['answerable', 'referenceSupported', 'criteriaSupported', 'mappedItemsRequired', 'requiresCorpusKnowledge', 'unambiguous', 'answerLeakage'];

export function buildVerificationPrompt(question, evidence, source) {
  const evidenceById = new Map(evidence.map((item) => [item.evidenceId, item.quote]));
  const payload = {
    question: question.question,
    rubric: question.rubric.map(({ criterion, knowledgeItemIds }) => ({ criterion, knowledgeItemIds })),
    evidence: question.evidenceIds.map((id) => evidenceById.get(id)),
  };
  if (source !== undefined) payload.source = source;
  return [
    'Independently verify this extracted evaluation question against the supplied source. Return only one JSON object with boolean fields answerable, referenceSupported, criteriaSupported, mappedItemsRequired, requiresCorpusKnowledge, unambiguous, and answerLeakage, plus a non-empty reason string. answerLeakage is true when the question reveals its answer. The supplied source and evidence are corpus knowledge. requiresCorpusKnowledge is true when they are needed to answer correctly; it is false only when the answer follows from the question wording or generic domain conventions without consulting the supplied source.',
    'Set every boolean independently, then ensure the reason explains every failing boolean and does not contradict the boolean values. Judge answerability and rubric support against the complete source. Use mapped evidence to judge whether mappedItemsRequired is accurate. Do not repair the question or use outside knowledge.',
    '',
    'INPUT:',
    stableStringify(payload),
  ].join('\n');
}

export function parseVerificationResponse(response) {
  const data = parseJsonObject(response);
  for (const field of BOOLEAN_FIELDS) {
    if (typeof data[field] !== 'boolean') throw new InvalidStructuredResponse(`${field} must be a boolean`);
  }
  if (typeof data.reason !== 'string' || !data.reason.trim()) throw new InvalidStructuredResponse('reason must be a non-empty string');
  const result = Object.fromEntries(BOOLEAN_FIELDS.map((field) => [field, data[field]]));
  result.reason = data.reason.trim();
  result.passed = result.answerable && result.referenceSupported && result.criteriaSupported && result.mappedItemsRequired && result.requiresCorpusKnowledge && result.unambiguous && !result.answerLeakage;
  return result;
}