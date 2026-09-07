import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CopilotSdkRunner } from '../src/copilot-sdk.js';
import { loadDataset } from '../src/dataset.js';
import { parseJsonObject, runStructured } from '../src/structured.js';

const [datasetArgument, referenceArgument, outputArgument = '.work/js-calibration/comparison.json'] = process.argv.slice(2);
if (!datasetArgument || !referenceArgument) throw new Error('Usage: npm run calibration:compare -- <dataset> <reference-questions.json> [output.json]');
const dataset = await loadDataset(datasetArgument);
const reference = JSON.parse(await readFile(referenceArgument, 'utf8'));
const evidenceById = new Map(dataset.evidence.map((item) => [item.evidenceId, item.quote]));
const generated = dataset.questions.map((question, index) => ({
  index: index + 1,
  question: question.question,
  rubric: question.rubric,
  evidence: question.evidenceIds.map((id) => evidenceById.get(id)),
}));
const outputPath = path.resolve(outputArgument);
const workRoot = path.dirname(outputPath);
const workspace = path.join(workRoot, 'compare-workspace');
await mkdir(workspace, { recursive: true });
const runner = new CopilotSdkRunner({ isolatedHome: path.join(workRoot, 'compare-home') });
const prompt = [
  'Compare EXPECTED against GENERATED semantically. For each expected question-answer pair, determine whether its complete answer is tested by one generated question and its rubric and evidence. Compound generated questions may cover multiple expected pairs. Require all material claims in the expected answer, allowing paraphrase.',
  'Report exactly one JSON object with: expectedCount, generatedCount, coveredCount, mappings (array of objects with expectedIndex, generatedIndex or null, covered boolean, reason), generatedExtras (array), contradictions (array), and conclusion.',
  '',
  'EXPECTED:',
  JSON.stringify(reference.questions),
  '',
  'GENERATED:',
  JSON.stringify(generated),
].join('\n');
const comparison = await runStructured({ runner, workspace, prompt, validator: validateComparison, maxAttempts: 2 });
await writeFile(outputPath, `${JSON.stringify(comparison, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ comparisonPath: outputPath, coveredCount: comparison.coveredCount, expectedCount: comparison.expectedCount, generatedCount: comparison.generatedCount })}\n`);

function validateComparison(value) {
  const result = parseJsonObject(value);
  for (const field of ['expectedCount', 'generatedCount', 'coveredCount']) {
    if (!Number.isInteger(result[field]) || result[field] < 0) throw new Error(`${field} must be a non-negative integer`);
  }
  if (!Array.isArray(result.mappings) || !Array.isArray(result.generatedExtras) || !Array.isArray(result.contradictions) || typeof result.conclusion !== 'string') throw new Error('Comparison result has an invalid shape');
  return result;
}