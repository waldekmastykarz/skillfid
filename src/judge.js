import { stableStringify } from './json.js';
import { InvalidStructuredResponse, parseJsonObject } from './structured.js';

export class InvalidJudgeResponse extends InvalidStructuredResponse {}

export function buildJudgePrompt({ question, source, candidateAnswer, rubric }) {
  return [
    'Judge the candidate answer against each rubric criterion using only the complete supplied source as ground truth. Return only valid JSON with this shape:',
    '{"criterionResults":[{"criterionIndex":0,"score":0,"rationale":"..."}],"unsupportedClaims":[]}',
    'Scores must be numbers from 0 to 1. Include every criterion exactly once.',
    'INPUT:',
    stableStringify({ question, source, candidateAnswer, rubric }),
  ].join('\n');
}

export function parseJudgeResponse(response, criterionCount) {
  let data;
  try {
    data = parseJsonObject(response, 'Judge response');
  } catch (error) {
    throw new InvalidJudgeResponse(error.message);
  }
  if (!Array.isArray(data.criterionResults)) throw new InvalidJudgeResponse('criterionResults must be an array');
  if (data.criterionResults.length !== criterionCount) throw new InvalidJudgeResponse(`Expected ${criterionCount} criterion results, got ${data.criterionResults.length}`);
  const seen = new Set();
  const criterionResults = data.criterionResults.map((item) => {
    if (item === null || Array.isArray(item) || typeof item !== 'object') throw new InvalidJudgeResponse('Each criterion result must be an object');
    const { criterionIndex, score, rationale } = item;
    if (!Number.isInteger(criterionIndex)) throw new InvalidJudgeResponse('criterionIndex must be an integer');
    if (criterionIndex < 0 || criterionIndex >= criterionCount || seen.has(criterionIndex)) throw new InvalidJudgeResponse(`Invalid or duplicate criterionIndex: ${criterionIndex}`);
    if (typeof score !== 'number' || !Number.isFinite(score)) throw new InvalidJudgeResponse(`Criterion ${criterionIndex} score must be a number`);
    if (score < 0 || score > 1) throw new InvalidJudgeResponse(`Criterion ${criterionIndex} score must be from 0 to 1`);
    if (typeof rationale !== 'string' || !rationale.trim()) throw new InvalidJudgeResponse(`Criterion ${criterionIndex} rationale must not be empty`);
    seen.add(criterionIndex);
    return { criterionIndex, score, rationale: rationale.trim() };
  }).sort((left, right) => left.criterionIndex - right.criterionIndex);
  if (!Array.isArray(data.unsupportedClaims) || data.unsupportedClaims.some((claim) => typeof claim !== 'string')) throw new InvalidJudgeResponse('unsupportedClaims must be an array of strings');
  return { criterionResults, unsupportedClaims: data.unsupportedClaims.map((claim) => claim.trim()).filter(Boolean) };
}