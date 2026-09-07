import { stableStringify } from './json.js';
import { InvalidStructuredResponse, parseJsonObject } from './structured.js';
import { parseJudgeResponse } from './judge.js';

const INTEGRITY_FIELDS = ['directlyEntailed', 'contradictionChecked', 'qualificationsIncluded', 'authorityResolved', 'proxyAnswer'];
const VERIFICATION_FIELDS = ['answerable', 'referenceSupported', 'criteriaSupported', 'mappedItemsRequired', 'requiresCorpusKnowledge', 'unambiguous', 'answerLeakage'];

export function buildCalibrationPrompt({ question, source, candidateAnswer, rubric }) {
  return [
    'Calibrate this question and oracle answer against the complete supplied source documents. Return only valid JSON with this shape:',
    '{"criterionResults":[{"criterionIndex":0,"score":1,"rationale":"..."}],"unsupportedClaims":[],"verification":{"answerable":true,"referenceSupported":true,"criteriaSupported":true,"mappedItemsRequired":true,"requiresCorpusKnowledge":true,"unambiguous":true,"answerLeakage":false,"reason":"..."},"integrity":{"directlyEntailed":true,"contradictionChecked":true,"qualificationsIncluded":true,"authorityResolved":true,"proxyAnswer":false,"rationale":"..."}}',
    'Score every rubric criterion from 0 to 1. directlyEntailed means every answer claim follows from the complete source. contradictionChecked means the complete source was checked for conflicting passages. qualificationsIncluded means applicable exceptions and prerequisites are represented. authorityResolved means version and authority precedence are correctly handled. proxyAnswer is true when the answer merely resembles local evidence without establishing the source-supported answer. Set each field independently and explain the integrity verdict.',
    'INPUT:',
    stableStringify({ question, source, candidateAnswer, rubric }),
  ].join('\n');
}

export function parseCalibrationResponse(response, criterionCount) {
  const data = parseJsonObject(response, 'Calibration response');
  const judgment = parseJudgeResponse(response, criterionCount);
  if (data.verification === null || Array.isArray(data.verification) || typeof data.verification !== 'object') throw new InvalidStructuredResponse('verification must be an object');
  for (const field of VERIFICATION_FIELDS) if (typeof data.verification[field] !== 'boolean') throw new InvalidStructuredResponse(`verification.${field} must be a boolean`);
  if (typeof data.verification.reason !== 'string' || !data.verification.reason.trim()) throw new InvalidStructuredResponse('verification.reason must be a non-empty string');
  const verification = { ...Object.fromEntries(VERIFICATION_FIELDS.map((field) => [field, data.verification[field]])), reason: data.verification.reason.trim() };
  verification.passed = verification.answerable && verification.referenceSupported && verification.criteriaSupported && verification.mappedItemsRequired && verification.requiresCorpusKnowledge && verification.unambiguous && !verification.answerLeakage;
  if (data.integrity === null || Array.isArray(data.integrity) || typeof data.integrity !== 'object') throw new InvalidStructuredResponse('integrity must be an object');
  for (const field of INTEGRITY_FIELDS) if (typeof data.integrity[field] !== 'boolean') throw new InvalidStructuredResponse(`integrity.${field} must be a boolean`);
  if (typeof data.integrity.rationale !== 'string' || !data.integrity.rationale.trim()) throw new InvalidStructuredResponse('integrity.rationale must be a non-empty string');
  const integrity = { ...Object.fromEntries(INTEGRITY_FIELDS.map((field) => [field, data.integrity[field]])), rationale: data.integrity.rationale.trim() };
  integrity.passed = integrity.directlyEntailed && integrity.contradictionChecked && integrity.qualificationsIncluded && integrity.authorityResolved && !integrity.proxyAnswer;
  return { ...judgment, verification, integrity };
}
