import { stableStringify } from './json.js';

export const ORACLE_PROMPT_VERSION = '3';

export function subjectPrompt(question) {
  return ['Answer the user\'s question. Use an available skill when relevant.', 'Do not search external sources or use shell commands.', 'If the answer is not available in the provided context or an available skill, say that you do not know; do not infer or invent specific details.', 'Return only a concise final answer.', '', `User question: ${question}`].join('\n');
}

export function skillPrompt(question, invocationMode, skillName) {
  const prompt = subjectPrompt(question);
  return invocationMode === 'explicit' ? [`/${skillName}`, '', prompt].join('\n') : prompt;
}

export function oraclePrompt(question, source, rubric) {
  const lines = [
    'Answer the user\'s question using only the complete source below.',
    'Answer every part of the question with the source\'s stated detail.',
    'Preserve numbers, counts, qualifiers, causal claims, and scope exactly; do not round, broaden, combine, or strengthen them.',
    'When the source gives apparently conflicting measurements from different contexts, distinguish those contexts explicitly.',
    'If the source does not support a claim, omit it or state that it is not specified.',
    'Do not use skills, external sources, or shell commands. Return only the final answer.',
    '',
    `User question: ${question}`,
  ];
  if (rubric) lines.push(
    '',
    'Calibration coverage requirements:',
    stableStringify(rubric.map(({ criterion }) => criterion)),
    'Treat these requirements as minimum coverage, not an exhaustive answer boundary.',
    'Before answering, scan the complete source independently of the requirements for every passage that addresses the question. Account for all applicable prerequisites, exceptions, and repeated measurements, including relevant passages outside the sections represented by the requirements.',
    'Answer every requirement directly and answer the user\'s question fully, including relevant source facts and qualifications needed for accuracy and completeness.',
    'If a requirement conflicts with the source, the source wins: report every distinct source-supported value or outcome with its location or context, and never repeat the requirement unqualified.',
    'Treat the source as authoritative. Omit unrelated background, examples, and adjacent source facts.',
    'Add no claim merely because it appears in a requirement; every claim must be supported by the source.',
  );
  lines.push(
    '',
    'Use only this complete source:',
    stableStringify(source),
  );
  return lines.join('\n');
}