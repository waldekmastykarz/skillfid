import { skillFilesRead } from './trace.js';
import { SCORE_TOLERANCE } from './stats.js';

export const FAILURE_STAGES = ['not_discovered', 'retrieval_miss', 'false_refusal', 'hallucination', 'application_error', 'unknown'];
const SHINGLE_SIZE = 3;
const SHINGLE_OVERLAP = 0.8;
const REFUSAL_PATTERN = new RegExp([
  String.raw`\bi (?:do not|don't|dont) know\b`,
  String.raw`\bi(?:'m| am) not (?:sure|certain|able to)\b`,
  String.raw`\b(?:not|isn't|aren't|wasn't) (?:covered|specified|documented|available|mentioned|provided|described|addressed|stated|included|found)\b`,
  String.raw`\b(?:does not|doesn't|do not|don't|did not|didn't) (?:cover|specify|say|mention|provide|contain|include|describe|address|document|state|have)\b`,
  String.raw`\b(?:cannot|can't|can not|unable to|couldn't|could not) (?:find|answer|determine|confirm|say|tell)\b`,
  String.raw`\bno (?:information|mention|details?|guidance|documentation|data)\b`,
  String.raw`\b(?:not enough|insufficient) (?:information|context|detail)\b`,
  String.raw`\bunknown\b`,
].join('|'), 'i');

export function normalizeText(value) {
  return String(value ?? '').normalize('NFKC').replace(/[‘’‚′]/g, "'").replace(/[“”„″]/g, '"').toLowerCase().replace(/\s+/g, ' ').trim();
}

function words(value) {
  return normalizeText(value).match(/[\p{L}\p{N}]+/gu) ?? [];
}

function shingles(tokens, size) {
  const set = new Set();
  for (let index = 0; index + size <= tokens.length; index += 1) set.add(tokens.slice(index, index + size).join(' '));
  return set;
}

// True when the text contains the quote after whitespace/case normalization, or shares at least 80% of its word shingles.
export function containsEvidence(text, quote) {
  const needle = normalizeText(quote);
  if (!needle) return false;
  if (normalizeText(text).includes(needle)) return true;
  const quoteWords = words(quote);
  if (!quoteWords.length) return false;
  const size = Math.min(SHINGLE_SIZE, quoteWords.length);
  const wanted = shingles(quoteWords, size);
  const available = shingles(words(text), size);
  let overlap = 0;
  for (const shingle of wanted) if (available.has(shingle)) overlap += 1;
  return overlap / wanted.size >= SHINGLE_OVERLAP;
}

// Paths of the skill files that contain at least one of the evidence quotes.
export function filesContainingEvidence(files, quotes) {
  return files.filter((file) => typeof file.content === 'string' && quotes.some((quote) => containsEvidence(file.content, quote))).map((file) => file.path);
}

export function isRefusal(answer) {
  return REFUSAL_PATTERN.test(normalizeText(answer));
}

// Assigns the stage at which a failing skill trial went wrong. Returns undefined for perfect trials.
//   not_discovered     the skill was available but never loaded
//   false_refusal      the agent declined to answer although the evidence is in the skill
//   retrieval_miss     the skill loaded but none of the files it read contain the evidence
//   hallucination      the judge found claims the source does not support
//   application_error  the evidence was read yet the answer is still wrong
export function classifyFailure({ score, trace, skillFiles = [], evidenceQuotes = [], answer = '', unsupportedClaims = [] }) {
  if (score >= 1 - SCORE_TOLERANCE) return undefined;
  if (trace?.skillLoaded === false) return { stage: 'not_discovered', detail: { evidenceInSkill: undefined, evidenceRead: false } };
  const evidenceFiles = filesContainingEvidence(skillFiles, evidenceQuotes);
  const evidenceInSkill = evidenceQuotes.length ? evidenceFiles.length > 0 : undefined;
  const readPaths = new Set(skillFilesRead(trace).map((file) => file.path));
  const evidenceRead = trace && evidenceQuotes.length ? evidenceFiles.some((file) => readPaths.has(file)) : undefined;
  const detail = { evidenceInSkill, evidenceRead };
  if (isRefusal(answer) && (evidenceRead || evidenceInSkill)) return { stage: 'false_refusal', detail };
  if (evidenceRead === false) return { stage: 'retrieval_miss', detail };
  if (unsupportedClaims.length) return { stage: 'hallucination', detail };
  if (evidenceRead) return { stage: 'application_error', detail };
  return { stage: 'unknown', detail };
}

export function summarizeStages(skillAnswers) {
  const counts = Object.fromEntries(FAILURE_STAGES.map((stage) => [stage, 0]));
  for (const answer of skillAnswers) if (answer.stage in counts) counts[answer.stage] += 1;
  return counts;
}

// The most frequent failing stage among a question's trials; ties go to the earlier stage in the pipeline.
export function dominantStage(skillAnswers) {
  const counts = summarizeStages(skillAnswers);
  const [stage, count] = FAILURE_STAGES.map((item) => [item, counts[item]]).reduce((best, entry) => (entry[1] > best[1] ? entry : best), [undefined, 0]);
  return count ? stage : undefined;
}
