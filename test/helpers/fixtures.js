import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { stableStringify } from '../../src/json.js';

export const DOCUMENT = [
  '# Guide', '',
  '## Limits', 'The limit is two gigabytes.', '',
  '## Retention', 'Data is kept for fourteen days.', '',
  '## Billing', 'Billing happens monthly.', '',
  '## Support', 'Support is available around the clock.', '',
  '## Security', 'Keys rotate every ninety days.', '',
].join('\n');

export const QUESTIONS = [
  { key: 'limit', type: 'fact', difficulty: 'easy', importance: 'high', quote: 'The limit is two gigabytes.', question: 'What is the size limit?', expected: 'two gigabytes' },
  { key: 'retention', type: 'fact', difficulty: 'medium', importance: 'medium', quote: 'Data is kept for fourteen days.', question: 'How long is data kept?', expected: 'fourteen days' },
  { key: 'billing', type: 'procedure', difficulty: 'easy', importance: 'high', quote: 'Billing happens monthly.', question: 'How often does billing happen?', expected: 'monthly' },
  { key: 'support', type: 'procedure', difficulty: 'hard', importance: 'low', quote: 'Support is available around the clock.', question: 'When is support available?', expected: 'around the clock' },
  { key: 'security', type: 'synthesis', difficulty: 'hard', importance: 'high', quote: 'Keys rotate every ninety days.', question: 'How often do keys rotate?', expected: 'ninety days' },
];

const sha = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const sectionHeading = { limit: 'Limits', retention: 'Retention', billing: 'Billing', support: 'Support', security: 'Security' };

// Writes a schema v6 dataset directory with a valid content hash and perfect oracle calibration.
export async function writeDatasetFixture(root, specs = QUESTIONS) {
  const documents = [{ documentId: 'guide.md', content: DOCUMENT }];
  const knowledge = [];
  const evidence = [];
  const questions = [];
  const calibrations = [];
  for (const spec of specs) {
    const start = DOCUMENT.indexOf(spec.quote);
    const evidenceId = `ev_${spec.key}`;
    const knowledgeId = `ki_${spec.key}`;
    const testId = `ke_${spec.key}`;
    evidence.push({ documentId: 'guide.md', evidenceId, quote: spec.quote, revision: 'r1', sectionId: `sec_${spec.key}`, start, end: start + spec.quote.length });
    knowledge.push({ evidenceIds: [evidenceId], importance: spec.importance, importanceReason: 'Because.', kind: 'fact', knowledgeId, sectionId: `sec_${spec.key}`, statement: spec.quote });
    questions.push({ difficulty: spec.difficulty, evidenceIds: [evidenceId], question: spec.question, questionType: spec.type, rubric: [{ criterion: `States ${spec.expected}.`, knowledgeItemIds: [knowledgeId], weight: 1 }], testId });
    calibrations.push({ testId, score: 1, criterionResults: [{ criterionIndex: 0, score: 1, rationale: 'Complete.' }], unsupportedClaims: [], integrity: { passed: true } });
  }
  const sort = (records, key) => [...records].sort((left, right) => left[key].localeCompare(right[key], 'en'));
  const content = { corpusRevision: 'corpus-1', documents, knowledge: sort(knowledge, 'knowledgeId'), questions: sort(questions, 'testId'), evidence: sort(evidence, 'evidenceId'), calibrations: sort(calibrations, 'testId') };
  const datasetId = `ds_${sha(stableStringify(content)).slice(0, 16)}`;
  const datasetPath = path.join(root, datasetId);
  await mkdir(datasetPath, { recursive: true });
  const jsonl = (records) => records.map((record) => stableStringify(record)).join('\n') + '\n';
  await Promise.all([
    writeFile(path.join(datasetPath, 'documents.jsonl'), jsonl(content.documents)),
    writeFile(path.join(datasetPath, 'knowledge.jsonl'), jsonl(content.knowledge)),
    writeFile(path.join(datasetPath, 'questions.jsonl'), jsonl(content.questions)),
    writeFile(path.join(datasetPath, 'evidence.jsonl'), jsonl(content.evidence)),
    writeFile(path.join(datasetPath, 'calibrations.jsonl'), jsonl(content.calibrations)),
    writeFile(path.join(datasetPath, 'coverage.json'), JSON.stringify({ coverage: 1 })),
    writeFile(path.join(datasetPath, 'manifest.json'), JSON.stringify({ schemaVersion: 6, datasetId, corpusRevision: 'corpus-1', calibration: { requiredScore: 1, model: 'calibrated-subject', judgeModel: 'calibrated-judge', reasoningEffort: 'high' } })),
  ]);
  return { datasetPath, datasetId, specs, headings: sectionHeading };
}

export async function writeSkill(directory, files = {}) {
  const all = { 'SKILL.md': '---\nname: test-skill\ndescription: Facts.\n---\n# Test skill\n\nRead references/facts.md.\n', 'references/facts.md': [DOCUMENT].join('\n'), ...files };
  for (const [relative, content] of Object.entries(all)) {
    await mkdir(path.dirname(path.join(directory, relative)), { recursive: true });
    await writeFile(path.join(directory, relative), content);
  }
  return directory;
}

// Fake runner for subject and judge roles. `behavior(question, ctx)` returns {answer, trace?}; the default answers correctly after reading SKILL.md.
export function createFakeRunner({ behavior, calls = [] } = {}) {
  const expectedByQuestion = new Map(QUESTIONS.map((spec) => [spec.question, spec.expected]));
  const defaultTrace = (kind) => (kind === 'skill' ? { skillLoaded: true, filesRead: [{ path: '.github/skills/skill/SKILL.md', bytes: 80 }], toolCalls: [{ name: 'skill', target: 'test-skill' }], turns: 2, inputTokens: 100, outputTokens: 10 } : { skillLoaded: null, filesRead: [], toolCalls: [], turns: 1, inputTokens: 50, outputTokens: 5 });
  return {
    calls,
    async listSkills(workspace) { return path.basename(workspace) === 'skill' ? [{ name: 'test-skill', source: 'project' }] : []; },
    async version() { return 'test'; },
    async close() {},
    async run(workspace, prompt) {
      if (prompt.includes('Judge the candidate answer')) {
        const input = JSON.parse(prompt.split('INPUT:\n')[1]);
        const expected = expectedByQuestion.get(input.question);
        calls.push({ role: 'judge', question: input.question });
        const matches = input.candidateAnswer.includes(expected);
        return { answer: JSON.stringify({ criterionResults: [{ criterionIndex: 0, score: matches ? 1 : 0, rationale: matches ? 'Complete.' : 'Missing.' }], unsupportedClaims: input.candidateAnswer.includes('INVENTED') ? ['An invented claim.'] : [] }) };
      }
      if (prompt.includes('Audit whether the supplied skill')) {
        calls.push({ role: 'audit', prompt });
        return { answer: JSON.stringify({ present: false, complete: false, contradictory: false, files: [], rationale: 'Missing.' }) };
      }
      if (prompt.includes('Judge how an agent that has the supplied skill behaved')) {
        const input = JSON.parse(prompt.split('INPUT:\n')[1]);
        calls.push({ role: 'probeJudge', question: input.question });
        const refused = /do not know/i.test(input.candidateAnswer);
        return { answer: JSON.stringify({ refused, hallucinated: input.candidateAnswer.includes('INVENTED'), behaviors: input.expectedBehaviors.map((_, index) => ({ index, passed: input.candidateAnswer.includes('CITED'), rationale: 'Checked.' })), rationale: 'Judged.' }) };
      }
      const question = /User question: (.*)$/m.exec(prompt)?.[1];
      const kind = path.basename(workspace) === 'skill' ? 'skill' : 'closedBook';
      calls.push({ role: 'subject', kind, question, workspace, prompt });
      const result = behavior?.(question, { kind, workspace, prompt }) ?? {};
      const answer = result.answer ?? (kind === 'skill' ? expectedByQuestion.get(question) ?? 'unknown' : 'I do not know');
      return { answer, durationSeconds: result.durationSeconds ?? 0.1, trace: result.trace ?? defaultTrace(kind) };
    },
  };
}
