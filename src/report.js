import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { loadDataset } from './dataset.js';
import { readJson, readJsonl } from './files.js';

const PERFECT_SCORE_TOLERANCE = 1e-9;
const REPORT_DATA_MARKER = '__SKILLFID_REPORT_DATA__';
const TEMPLATE_PATH = new URL('../templates/evaluation-report.html', import.meta.url);

export async function generateEvaluationReport({ runPath, datasetPath, outputPath, title = 'Skill evaluation' }) {
  const runRoot = path.resolve(runPath);
  const [dataset, knowledge, manifest, summary, answers, judgments, diagnoses, template] = await Promise.all([
    loadDataset(datasetPath),
    readJsonl(path.join(path.resolve(datasetPath), 'knowledge.jsonl')),
    readJson(path.join(runRoot, 'manifest.json')),
    readJson(path.join(runRoot, 'summary.json')),
    readJsonl(path.join(runRoot, 'answers.jsonl')),
    readJsonl(path.join(runRoot, 'judgments.jsonl')),
    readJsonl(path.join(runRoot, 'diagnoses.jsonl')),
    readFile(TEMPLATE_PATH, 'utf8'),
  ]);
  const model = buildReportModel({ title, manifest, summary, dataset, knowledge, answers, judgments, diagnoses });
  const destination = path.resolve(outputPath ?? path.join(runRoot, 'report.html'));
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, renderReport(template, model), 'utf8');
  return destination;
}

export function renderReport(template, model) {
  const occurrences = template.split(REPORT_DATA_MARKER).length - 1;
  if (occurrences !== 1) throw new Error(`Report template must contain exactly one ${REPORT_DATA_MARKER} marker`);
  const payload = JSON.stringify(model).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
  return template.replace(REPORT_DATA_MARKER, payload);
}

export function buildReportModel({ title, manifest, summary, dataset, knowledge, answers, judgments, diagnoses }) {
  if (manifest.datasetId !== dataset.datasetId || summary.datasetId !== dataset.datasetId) {
    throw new Error(`Evaluation run dataset ${manifest.datasetId} does not match dataset ${dataset.datasetId}`);
  }

  const answersByTest = groupBy(answers, (answer) => answer.testId);
  const judgmentsByTest = groupBy(judgments.filter((judgment) => judgment.condition === 'skill'), (judgment) => judgment.testId);
  const judgmentsByTrial = new Map(judgments.map((judgment) => [trialKey(judgment), judgment]));
  const diagnosesByTest = new Map(diagnoses.map((diagnosis) => [diagnosis.testId, diagnosis]));
  const evidenceById = new Map(dataset.evidence.map((evidence) => [evidence.evidenceId, evidence]));
  const tests = dataset.questions.map((question) => {
    const testAnswers = answersByTest.get(question.testId) ?? [];
    const baselineAnswers = testAnswers.filter((answer) => answer.condition === 'closedBook');
    const skillAnswers = testAnswers.filter((answer) => answer.condition === 'skill');
    const baselineScore = average(baselineAnswers.map((answer) => answer.score));
    const skillScore = average(skillAnswers.map((answer) => answer.score));
    const diagnosis = diagnosesByTest.get(question.testId);
    const diagnosisCategory = diagnosis?.category === 'unknown' && new Set(skillAnswers.map((answer) => answer.score)).size > 1 ? 'answer_variability' : diagnosis?.category ?? 'none';
    const failedRationales = unique((judgmentsByTest.get(question.testId) ?? []).flatMap((judgment) => judgment.criterionResults.filter((criterion) => criterion.score < 1).map((criterion) => criterion.rationale)));
    const sourceEvidence = question.evidenceIds.map((evidenceId) => evidenceById.get(evidenceId)).filter(Boolean);
    const shownEvidence = sourceEvidence.slice(0, 3).map((evidence) => `${evidence.documentId}: “${evidence.quote}”`);
    if (sourceEvidence.length > shownEvidence.length) shownEvidence.push(`Plus ${sourceEvidence.length - shownEvidence.length} more evidence record${sourceEvidence.length - shownEvidence.length === 1 ? '' : 's'}.`);
    return {
      testId: question.testId,
      question: question.question,
      questionType: question.questionType,
      status: scoreStatus(skillScore),
      baseline: formatScore(baselineScore),
      skill: formatScore(skillScore),
      cause: diagnosisCategory,
      criterion: question.rubric.map((criterion) => criterion.criterion).join(' '),
      rationale: failedRationales.join(' ') || 'All rubric criteria passed.',
      source: shownEvidence.join(' '),
      fix: diagnosis?.fixTargets?.length ? diagnosis.fixTargets.map((target) => `${target.file}: ${target.recommendation}`).join(' ') : 'No change recommended.',
      trials: {
        closedBook: trialDetails(baselineAnswers, judgmentsByTrial),
        skill: trialDetails(skillAnswers, judgmentsByTrial),
      },
      diagnosis: diagnosis ? {
        confidence: diagnosis.confidence,
        evidence: diagnosis.evidence ?? [],
        diagnosticReruns: (diagnosis.diagnosticReruns ?? []).map((rerun) => ({ ...rerun, score: formatScore(rerun.score) })),
      } : undefined,
    };
  });
  const recommendations = aggregateRecommendations(diagnoses);
  const distribution = {
    perfect: tests.filter((test) => test.status === 'perfect').length,
    strong: tests.filter((test) => test.status === 'strong').length,
    mixed: tests.filter((test) => test.status === 'mixed').length,
    weak: tests.filter((test) => test.status === 'weak').length,
    zero: tests.filter((test) => test.status === 'zero').length,
  };
  const actionableDiagnoses = diagnoses.filter((diagnosis) => diagnosis.fixTargets?.length);
  const documentCount = Object.keys(dataset.documents).length;
  const skillTrialScores = conditionTrialScores(answers, 'skill');

  return {
    title,
    createdAt: formatDate(manifest.createdAt),
    runId: manifest.runId,
    datasetId: dataset.datasetId,
    baselineId: manifest.baselineId,
    evaluatorVersion: manifest.evaluatorVersion,
    model: manifest.model,
    judgeModel: manifest.judgeModel,
    trialsPerQuestion: manifest.trialsPerQuestion,
    scores: {
      closedBook: formatScore(summary.conditionScores.closedBook),
      skill: formatScore(summary.conditionScores.skill),
      uplift: formatPercentagePoints(summary.skillUplift, true),
      skillTrials: skillTrialScores.map((score) => formatScore(score)),
    },
    verdict: buildVerdict(summary, { actionableDiagnoses: actionableDiagnoses.length, targetFiles: recommendations.length, skillTrialScores }),
    counts: {
      documents: documentCount,
      knowledge: knowledge.length,
      questions: dataset.questions.length,
      judgments: judgments.length,
      fullyCorrect: distribution.perfect,
      diagnosedFailures: summary.diagnosedFailures,
      actionableDiagnoses: actionableDiagnoses.length,
      targetFiles: recommendations.length,
    },
    distribution,
    recommendations,
    tests,
  };
}

function aggregateRecommendations(diagnoses) {
  const grouped = new Map();
  for (const diagnosis of diagnoses) {
    for (const target of diagnosis.fixTargets ?? []) {
      const existing = grouped.get(target.file) ?? { file: target.file, recommendations: new Map(), categories: new Map(), testIds: new Set() };
      const recommendationTests = existing.recommendations.get(target.recommendation) ?? new Set();
      recommendationTests.add(diagnosis.testId);
      existing.recommendations.set(target.recommendation, recommendationTests);
      existing.testIds.add(diagnosis.testId);
      const categoryTests = existing.categories.get(diagnosis.category) ?? new Set();
      categoryTests.add(diagnosis.testId);
      existing.categories.set(diagnosis.category, categoryTests);
      grouped.set(target.file, existing);
    }
  }
  return [...grouped.values()]
    .map((item) => ({
      file: item.file,
      changes: [...item.recommendations.entries()]
        .map(([recommendation, testIds]) => ({ recommendation, affectedTests: testIds.size }))
        .sort((left, right) => right.affectedTests - left.affectedTests || left.recommendation.localeCompare(right.recommendation, 'en')),
      category: item.categories.size === 1 ? [...item.categories.keys()][0] : 'multiple',
      affectedTests: item.testIds.size,
    }))
    .sort((left, right) => right.affectedTests - left.affectedTests || left.file.localeCompare(right.file, 'en'));
}

function buildVerdict(summary, { actionableDiagnoses, targetFiles, skillTrialScores }) {
  const label = actionableDiagnoses ? `${actionableDiagnoses} actionable diagnoses across ${targetFiles} target file${targetFiles === 1 ? '' : 's'}` : 'No concrete file changes diagnosed';
  const uplift = formatPercentagePoints(summary.skillUplift, true).replace(' pp', ' percentage points');
  const trialRange = skillTrialScores.length > 1 ? ` Skill trial aggregates ranged from ${formatScore(Math.min(...skillTrialScores))} to ${formatScore(Math.max(...skillTrialScores))}.` : '';
  const detail = `${uplift} over the model alone.${trialRange} ${summary.diagnosedFailures} question${summary.diagnosedFailures === 1 ? '' : 's'} were below perfect across the measured trials; ${actionableDiagnoses} produced concrete fix targets.`;
  return { label, headline: 'Measured outcome for this benchmark', detail };
}

function scoreStatus(score) {
  if (Math.abs(score - 1) <= PERFECT_SCORE_TOLERANCE) return 'perfect';
  if (score >= 0.9) return 'strong';
  if (score >= 0.7) return 'mixed';
  return score > 0 ? 'weak' : 'zero';
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function formatScore(score, signed = false) {
  if (score === 0 || Math.abs(score) === 1) return `${signed && score > 0 ? '+' : ''}${score * 100}%`;
  const percentage = score * 100;
  let precision = 3;
  let formatted = percentage.toFixed(precision);
  while (Number(formatted) === Math.sign(score) * 100 && precision < 10) {
    precision += 1;
    formatted = percentage.toFixed(precision);
  }
  formatted = formatted.replace(/\.0+$|(\.\d*?)0+$/, '$1');
  return `${signed && score > 0 ? '+' : ''}${formatted}%`;
}

function formatPercentagePoints(score, signed = false) {
  return `${formatScore(score, signed).slice(0, -1)} pp`;
}

function conditionTrialScores(answers, condition) {
  return [...groupBy(answers.filter((answer) => answer.condition === condition), (answer) => answer.trial).entries()]
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([, trialAnswers]) => average(trialAnswers.map((answer) => answer.score)));
}

function trialDetails(answers, judgmentsByTrial) {
  return [...answers]
    .sort((left, right) => Number(left.trial ?? 0) - Number(right.trial ?? 0))
    .map((answer, index) => {
      const judgment = judgmentsByTrial.get(trialKey(answer));
      return {
        trial: answer.trial ?? index,
        score: formatScore(answer.score),
        answer: answer.answer ?? '',
        failedCriteria: judgment?.criterionResults?.filter((criterion) => criterion.score < 1).map((criterion) => criterion.rationale) ?? [],
      };
    });
}

function trialKey(record) {
  return `${record.testId}:${record.trial ?? 0}:${record.condition}`;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat('en', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date);
}

function groupBy(values, key) {
  const grouped = new Map();
  for (const value of values) {
    const id = key(value);
    const entries = grouped.get(id) ?? [];
    entries.push(value);
    grouped.set(id, entries);
  }
  return grouped;
}

function unique(values) {
  return [...new Set(values)];
}