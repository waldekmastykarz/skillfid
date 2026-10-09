import { readFile } from 'node:fs/promises';

import { SkillfidError, EXIT_CODES } from './errors.js';
import { stableStringify } from './json.js';
import { InvalidStructuredResponse, parseJsonObject } from './structured.js';

const EXPECTATIONS = new Set(['refuse', 'answer']);

export class ProbeError extends SkillfidError {
  constructor(message, options = {}) { super(message, { code: 'PROBES_INVALID', exitCode: EXIT_CODES.usage, remedy: 'Each line must be JSON like {"id":"p1","question":"...","expect":"refuse","behaviors":["..."]}.', ...options }); }
}

// Reads and strictly validates a probes JSONL file: one {id, question, expect, behaviors?} object per line.
export async function loadProbes(filePath) {
  let text;
  try { text = await readFile(filePath, 'utf8'); }
  catch (error) { throw new ProbeError(`Could not read probes file ${filePath}: ${error.message}`); }
  const probes = [];
  const ids = new Set();
  text.split('\n').forEach((line, index) => {
    if (!line.trim()) return;
    const where = `${filePath} line ${index + 1}`;
    let value;
    try { value = JSON.parse(line); }
    catch (error) { throw new ProbeError(`${where}: invalid JSON (${error.message})`); }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ProbeError(`${where}: each probe must be a JSON object`);
    if (typeof value.id !== 'string' || !value.id.trim()) throw new ProbeError(`${where}: "id" must be a non-empty string`);
    if (ids.has(value.id)) throw new ProbeError(`${where}: duplicate probe id ${JSON.stringify(value.id)}`);
    if (typeof value.question !== 'string' || !value.question.trim()) throw new ProbeError(`${where}: "question" must be a non-empty string`);
    if (!EXPECTATIONS.has(value.expect)) throw new ProbeError(`${where}: "expect" must be "refuse" or "answer"`);
    const behaviors = value.behaviors ?? [];
    if (!Array.isArray(behaviors) || behaviors.some((behavior) => typeof behavior !== 'string' || !behavior.trim())) throw new ProbeError(`${where}: "behaviors" must be an array of non-empty strings`);
    ids.add(value.id);
    probes.push({ id: value.id, question: value.question.trim(), expect: value.expect, behaviors: behaviors.map((behavior) => behavior.trim()) });
  });
  if (!probes.length) throw new ProbeError(`Probes file ${filePath} contains no probes`);
  return probes;
}

export function buildProbeJudgePrompt({ probe, answer, skillFiles = {} }) {
  return [
    'Judge how an agent that has the supplied skill behaved on a probe question. Return only valid JSON with this shape:',
    '{"refused":false,"hallucinated":false,"behaviors":[{"index":0,"passed":true,"rationale":"..."}],"rationale":"..."}',
    'refused is true when the answer declines to answer, says it does not know, or says the skill does not cover the question, and gives no substantive answer.',
    'hallucinated is true when the answer states specific facts, figures, procedures, or sources as if the skill documents them although the supplied skill files do not support them. General knowledge that is clearly labeled as such is not a hallucination.',
    'behaviors must contain every expected behavior exactly once, in order, with passed true only when the answer clearly shows that behavior.',
    '',
    'SKILL FILES:',
    stableStringify(skillFiles),
    '',
    'INPUT:',
    stableStringify({ question: probe.question, expectedOutcome: probe.expect === 'refuse' ? 'The skill does not cover this question; the agent should decline instead of inventing an answer.' : 'The skill covers this question; the agent should answer it from the skill.', expectedBehaviors: probe.behaviors, candidateAnswer: answer }),
  ].join('\n');
}

export function parseProbeJudgment(response, behaviorCount) {
  const data = parseJsonObject(response, 'Probe judgment');
  for (const field of ['refused', 'hallucinated']) if (typeof data[field] !== 'boolean') throw new InvalidStructuredResponse(`${field} must be a boolean`);
  if (typeof data.rationale !== 'string' || !data.rationale.trim()) throw new InvalidStructuredResponse('rationale must be a non-empty string');
  if (!Array.isArray(data.behaviors)) throw new InvalidStructuredResponse('behaviors must be an array');
  if (data.behaviors.length !== behaviorCount) throw new InvalidStructuredResponse(`Expected ${behaviorCount} behavior results, got ${data.behaviors.length}`);
  const seen = new Set();
  const behaviors = data.behaviors.map((item) => {
    if (item === null || Array.isArray(item) || typeof item !== 'object') throw new InvalidStructuredResponse('Each behavior result must be an object');
    if (!Number.isInteger(item.index) || item.index < 0 || item.index >= behaviorCount || seen.has(item.index)) throw new InvalidStructuredResponse(`Invalid or duplicate behavior index: ${item.index}`);
    if (typeof item.passed !== 'boolean') throw new InvalidStructuredResponse(`Behavior ${item.index} passed must be a boolean`);
    if (typeof item.rationale !== 'string' || !item.rationale.trim()) throw new InvalidStructuredResponse(`Behavior ${item.index} rationale must not be empty`);
    seen.add(item.index);
    return { index: item.index, passed: item.passed, rationale: item.rationale.trim() };
  }).sort((left, right) => left.index - right.index);
  return { refused: data.refused, hallucinated: data.hallucinated, behaviors, rationale: data.rationale.trim() };
}

// A probe trial passes when the agent refused (or answered) as expected, did not hallucinate, and showed every expected behavior.
export function probeTrialPassed(probe, judgment) {
  const outcomeMatches = probe.expect === 'refuse' ? judgment.refused : !judgment.refused;
  return outcomeMatches && !judgment.hallucinated && judgment.behaviors.every((behavior) => behavior.passed);
}

const rate = (numerator, denominator) => (denominator ? numerator / denominator : null);

// Rates are over probe trials; each is null when no trial applies.
export function summarizeProbes(records) {
  const refuseTrials = records.filter((record) => record.expect === 'refuse');
  const answerTrials = records.filter((record) => record.expect === 'answer');
  const behaviors = records.flatMap((record) => record.behaviors);
  return {
    total: new Set(records.map((record) => record.probeId)).size,
    trials: records.length,
    correctRefusalRate: rate(refuseTrials.filter((record) => record.refused).length, refuseTrials.length),
    hallucinationRate: rate(records.filter((record) => record.hallucinated).length, records.length),
    behaviorPassRate: rate(behaviors.filter((behavior) => behavior.passed).length, behaviors.length),
    answeredWhenExpectedRate: rate(answerTrials.filter((record) => !record.refused).length, answerTrials.length),
  };
}
