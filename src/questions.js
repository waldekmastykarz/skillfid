import { createHash } from 'node:crypto';

import { stableStringify } from './json.js';
import { InvalidStructuredResponse, parseJsonObject } from './structured.js';
import { requiredString } from './inventory.js';

export const MAX_ITEMS_PER_QUESTION = 6;
const QUESTION_TYPES = new Set(['fact', 'procedure', 'application', 'synthesis', 'conflict']);
const DIFFICULTIES = new Set(['easy', 'medium', 'hard']);

export function buildQuestionPrompt(items, evidence) {
  const evidenceById = new Map(evidence.map((record) => [record.evidenceId, record.quote]));
  const payload = items.map((item) => ({
    knowledgeId: item.knowledgeId,
    kind: item.kind,
    statement: item.statement,
    importance: item.importance,
    evidence: item.evidenceIds.map((id) => evidenceById.get(id)),
  }));
  return [
    'Generate focused, independently scorable, user-realistic questions that test every supplied knowledge item. Each item must be required by at least one rubric criterion. Each question must cover one coherent operational concern. Before writing questions, group items into the complete local concerns expressed by the source: a storage policy includes both placement and read behavior; a tier policy includes eligibility and backing media; a retention policy includes its rationale; an admission policy includes all paired limits, overload behavior, and stated risks. Preserve a source paragraph\'s coherent concern when it fits within the item limit instead of splitting its facts across questions.',
    'Knowledge items may appear in more than one question when overlap is necessary to make related questions complete. Combine configuration with backing, policy with rationale, trigger with response, paired limits, and mechanism with purpose. Prefer one complete question over atomizing those relationships. Do not combine unrelated operational concerns merely to reduce the number of questions.',
    `A question may cover at most ${MAX_ITEMS_PER_QUESTION} knowledge items.`,
    'Do not include tested values, limits, outcomes, or other answer-bearing facts in the question. A model without the supplied knowledge must not be able to derive the answer from the wording or generic domain conventions. Every claim in each rubric criterion must be explicitly supported by the supplied evidence.',
    '',
    'Return only one JSON object with this shape:',
    '{"questions":[{"question":"...","type":"fact","difficulty":"medium","rubric":[{"criterion":"...","weight":1,"knowledgeItemIds":["ki_..."]}]}]}',
    'Allowed types: fact, procedure, application, synthesis, conflict. Allowed difficulties: easy, medium, hard. Rubric weights for each question must be positive and sum to 1. Use only supplied knowledge IDs.',
    '',
    'KNOWLEDGE INVENTORY:',
    stableStringify(payload),
  ].join('\n');
}

export function parseQuestionResponse(response, items) {
  const data = parseJsonObject(response);
  if (!Array.isArray(data.questions) || !data.questions.length) throw new InvalidStructuredResponse('questions must be a non-empty array');
  const itemById = new Map(items.map((item) => [item.knowledgeId, item]));
  const coveredIds = new Set();
  const seen = new Set();
  const questions = data.questions.map((rawQuestion) => {
    if (rawQuestion === null || Array.isArray(rawQuestion) || typeof rawQuestion !== 'object') throw new InvalidStructuredResponse('Each question must be an object');
    if ('referenceAnswer' in rawQuestion || 'reference_answer' in rawQuestion) throw new InvalidStructuredResponse('Questions must not include a reference answer; the source is ground truth');
    const question = requiredString(rawQuestion, 'question');
    const questionType = requiredString(rawQuestion, 'type');
    const difficulty = requiredString(rawQuestion, 'difficulty');
    if (!QUESTION_TYPES.has(questionType)) throw new InvalidStructuredResponse(`Unsupported question type: ${questionType}`);
    if (!DIFFICULTIES.has(difficulty)) throw new InvalidStructuredResponse(`Unsupported difficulty: ${difficulty}`);
    if (seen.has(question)) throw new InvalidStructuredResponse(`Duplicate question: ${question}`);
    if (!Array.isArray(rawQuestion.rubric) || !rawQuestion.rubric.length) throw new InvalidStructuredResponse('rubric must be a non-empty array');
    let totalWeight = 0;
    const questionItemIds = new Set();
    const rubric = rawQuestion.rubric.map((rawCriterion) => {
      if (rawCriterion === null || Array.isArray(rawCriterion) || typeof rawCriterion !== 'object') throw new InvalidStructuredResponse('Each rubric criterion must be an object');
      const criterion = requiredString(rawCriterion, 'criterion');
      const { weight, knowledgeItemIds } = rawCriterion;
      if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) throw new InvalidStructuredResponse('Rubric weight must be a positive number');
      if (!Array.isArray(knowledgeItemIds) || !knowledgeItemIds.length || knowledgeItemIds.some((id) => typeof id !== 'string')) throw new InvalidStructuredResponse('knowledgeItemIds must be a non-empty string array');
      const unknown = [...new Set(knowledgeItemIds)].filter((id) => !itemById.has(id));
      if (unknown.length) throw new InvalidStructuredResponse(`Rubric references unknown knowledge IDs: ${unknown.sort().join(', ')}`);
      totalWeight += weight;
      knowledgeItemIds.forEach((id) => questionItemIds.add(id));
      return { criterion, weight, knowledgeItemIds: [...new Set(knowledgeItemIds)].sort() };
    });
    if (Math.abs(totalWeight - 1) > 1e-6) throw new InvalidStructuredResponse(`Rubric weights must sum to 1, got ${totalWeight}`);
    if (questionItemIds.size > MAX_ITEMS_PER_QUESTION) throw new InvalidStructuredResponse(`A question may cover at most ${MAX_ITEMS_PER_QUESTION} knowledge items, got ${questionItemIds.size}`);
    const evidenceIds = [...new Set([...questionItemIds].flatMap((id) => itemById.get(id).evidenceIds))].sort();
    const testId = `ke_${digest(`${question}:${[...questionItemIds].sort().join(',')}`).slice(0, 16)}`;
    questionItemIds.forEach((id) => coveredIds.add(id));
    seen.add(question);
    return { testId, question, questionType, difficulty, rubric, evidenceIds };
  });
  const missing = [...itemById.keys()].filter((id) => !coveredIds.has(id));
  if (missing.length) throw new InvalidStructuredResponse(`Questions do not cover knowledge IDs: ${missing.sort().join(', ')}`);
  return questions;
}

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}