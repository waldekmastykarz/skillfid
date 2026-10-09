import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { loadDataset } from './dataset.js';
import { readJson, readJsonl } from './files.js';
import { buildSectionIndex, questionDocuments, questionImportance, questionSections } from './selection.js';
import { FAILURE_STAGES, summarizeStages } from './staging.js';
import { buildStatistics, usageSummary } from './summary.js';
import { summarizeDisclosure } from './trace.js';

const PERFECT_SCORE_TOLERANCE = 1e-9;
const REPORT_DATA_MARKER = '__SKILLFID_REPORT_DATA__';
const TEMPLATE_PATH = new URL('../templates/evaluation-report.html', import.meta.url);
const STAGE_LABELS = { not_discovered: 'Skill not discovered', retrieval_miss: 'Retrieval miss', false_refusal: 'False refusal', hallucination: 'Hallucination', application_error: 'Application error', unknown: 'Unclassified' };
const DIFFICULTY_ORDER = ['easy', 'medium', 'hard'];
const IMPORTANCE_ORDER = ['high', 'medium', 'low', 'unmapped'];

export async function generateEvaluationReport({ runPath, datasetPath, outputPath, title = 'Skill evaluation' }) {
  const runRoot = path.resolve(runPath);
  const [dataset, manifest, summary, answers, judgments, diagnoses, template] = await Promise.all([
    loadDataset(datasetPath),
    readJson(path.join(runRoot, 'manifest.json')),
    readJson(path.join(runRoot, 'summary.json')),
    readJsonl(path.join(runRoot, 'answers.jsonl')),
    readJsonl(path.join(runRoot, 'judgments.jsonl')),
    readJsonl(path.join(runRoot, 'diagnoses.jsonl')),
    readFile(TEMPLATE_PATH, 'utf8'),
  ]);
  const knowledge = dataset.knowledge ?? await readJsonl(path.join(path.resolve(datasetPath), 'knowledge.jsonl'));
  const probesPath = path.join(runRoot, 'probes.jsonl');
  const probes = await access(probesPath).then(() => readJsonl(probesPath), () => []);
  const model = buildReportModel({ title, manifest, summary, dataset, knowledge, answers, judgments, diagnoses, probes });
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

export function buildReportModel({ title, manifest, summary, dataset, knowledge = [], answers, judgments, diagnoses, probes = [] }) {
  if (manifest.datasetId !== dataset.datasetId || summary.datasetId !== dataset.datasetId) {
    throw new Error(`Evaluation run dataset ${manifest.datasetId} does not match dataset ${dataset.datasetId}`);
  }

  const answersByTest = groupBy(answers, (answer) => answer.testId);
  const judgmentsByTest = groupBy(judgments.filter((judgment) => judgment.condition === 'skill'), (judgment) => judgment.testId);
  const judgmentsByTrial = new Map(judgments.map((judgment) => [trialKey(judgment), judgment]));
  const diagnosesByTest = new Map(diagnoses.map((diagnosis) => [diagnosis.testId, diagnosis]));
  const evidenceById = new Map(dataset.evidence.map((evidence) => [evidence.evidenceId, evidence]));
  const knowledgeById = new Map(knowledge.map((item) => [item.knowledgeId, item]));
  const sectionIndex = buildSectionIndex({ evidence: dataset.evidence, documents: dataset.documents });
  // Partial runs report only the questions they evaluated.
  const evaluatedQuestions = dataset.questions.filter((question) => answersByTest.has(question.testId));
  const tests = evaluatedQuestions.map((question) => {
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
    const stages = summarizeStages(skillAnswers);
    const stage = FAILURE_STAGES.map((name) => [name, stages[name]]).reduce((best, entry) => (entry[1] > best[1] ? entry : best), [undefined, 0])[0];
    return {
      testId: question.testId,
      question: question.question,
      questionType: question.questionType,
      difficulty: question.difficulty ?? 'unknown',
      importance: questionImportance(question, knowledgeById) ?? 'unmapped',
      sectionIds: questionSections(question, evidenceById),
      documentIds: questionDocuments(question, evidenceById),
      status: scoreStatus(skillScore),
      baselineValue: baselineScore,
      skillValue: skillScore,
      baseline: formatScore(baselineScore),
      skill: formatScore(skillScore),
      cause: diagnosisCategory,
      stage: stage ?? 'none',
      carried: skillAnswers.some((answer) => answer.carriedFrom),
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
  const skillScoreByTest = new Map(tests.map((test) => [test.testId, test.skillValue]));
  const recommendations = aggregateRecommendations(diagnoses, skillScoreByTest, tests.length);
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
  const statistics = buildStatistics({ testIds: tests.map((test) => test.testId), answers });
  const skillAnswers = answers.filter((answer) => answer.condition === 'skill');
  const failingTrials = skillAnswers.filter((answer) => answer.stage);
  const stageCounts = summarizeStages(skillAnswers);
  const subset = summary.subset ?? manifest.subset;
  const partial = manifest.partial || summary.partial ? { questions: tests.length, of: subset?.of ?? dataset.questions.length, sample: subset?.sample ?? (manifest.sample && { n: manifest.sample.n, seed: manifest.sample.seed }), filter: subset?.filter ?? manifest.filter } : undefined;

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
    adaptive: manifest.adaptive === true,
    partial,
    incremental: manifest.incremental ? { since: manifest.incremental.since, rerun: manifest.incremental.rerun, carried: manifest.incremental.carried, changedFiles: manifest.incremental.changedFiles } : undefined,
    scores: {
      closedBook: formatScore(summary.conditionScores.closedBook),
      skill: formatScore(summary.conditionScores.skill),
      uplift: formatPercentagePoints(summary.skillUplift, true),
      closedBookInterval: formatInterval(statistics.closedBook, false),
      skillInterval: formatInterval(statistics.skill, false),
      upliftInterval: formatInterval(statistics.uplift, true),
      skillTrials: skillTrialScores.map((score) => formatScore(score)),
      noise: statistics.skillNoise.questionsWithRepeatedTrials ? `${formatScore(statistics.skillNoise.answerVariability)} of questions varied between trials; mean within-question deviation ${formatPercentagePoints(statistics.skillNoise.meanWithinQuestionStdev)}` : undefined,
    },
    verdict: buildVerdict(summary, { actionableDiagnoses: actionableDiagnoses.length, targetFiles: recommendations.length, skillTrialScores, interval: statistics.uplift }),
    counts: {
      documents: documentCount,
      knowledge: knowledge.length,
      questions: tests.length,
      judgments: judgments.length,
      fullyCorrect: distribution.perfect,
      diagnosedFailures: summary.diagnosedFailures,
      actionableDiagnoses: actionableDiagnoses.length,
      targetFiles: recommendations.length,
    },
    distribution,
    breakdowns: {
      type: breakdown(tests, (test) => [[test.questionType, humanize(test.questionType)]]),
      difficulty: breakdown(tests, (test) => [[test.difficulty, humanize(test.difficulty)]], DIFFICULTY_ORDER),
      importance: breakdown(tests, (test) => [[test.importance, humanize(test.importance)]], IMPORTANCE_ORDER),
      document: breakdown(tests, (test) => test.documentIds.map((id) => [id, id]), undefined, true),
      section: breakdown(tests, (test) => test.sectionIds.map((id) => [id, sectionLabel(sectionIndex, id)]), undefined, true),
    },
    heatmap: buildHeatmap({ tests, sectionIndex, knowledge }),
    failureStages: {
      recorded: skillAnswers.some((answer) => answer.trace),
      failingTrials: failingTrials.length,
      rows: FAILURE_STAGES.map((stage) => ({ stage, label: STAGE_LABELS[stage], count: stageCounts[stage], share: failingTrials.length ? stageCounts[stage] / failingTrials.length : 0 })),
    },
    progressiveDisclosure: formatDisclosure(summarizeDisclosure(skillAnswers.map((answer) => answer.disclosure))),
    usage: { skill: formatUsage(usageSummary(skillAnswers)), closedBook: formatUsage(usageSummary(answers.filter((answer) => answer.condition === 'closedBook'))) },
    probes: probes.length ? buildProbesSection(probes, summary.probes) : undefined,
    recommendations,
    tests,
  };
}

function sectionLabel(index, id) {
  const section = index.get(id);
  return section ? section.label : id.replace(/^[a-z]+_/, '').slice(0, 8);
}

// One row per group of questions: n, baseline, skill and uplift. Questions with several sections or documents count once per group.
function breakdown(tests, groupsOf, order, byWorst = false) {
  const groups = new Map();
  for (const test of tests) {
    for (const [key, label] of groupsOf(test)) {
      const group = groups.get(key) ?? { key, label, tests: [] };
      group.tests.push(test);
      groups.set(key, group);
    }
  }
  const rows = [...groups.values()].map((group) => {
    const baseline = average(group.tests.map((test) => test.baselineValue));
    const skill = average(group.tests.map((test) => test.skillValue));
    return { key: group.key, label: group.label, n: group.tests.length, baseline: formatScore(baseline), skill: formatScore(skill), uplift: formatPercentagePoints(skill - baseline, true), skillValue: skill };
  });
  const position = (key) => (order.indexOf(key) === -1 ? 99 : order.indexOf(key));
  rows.sort((left, right) => {
    if (order) return position(left.key) - position(right.key);
    if (byWorst) return left.skillValue - right.skillValue || left.label.localeCompare(right.label, 'en');
    return right.n - left.n || left.label.localeCompare(right.label, 'en');
  });
  return rows.map(({ skillValue, ...row }) => row);
}

// One cell per document section, colored by the mean skill score of the questions grounded in it.
function buildHeatmap({ tests, sectionIndex, knowledge }) {
  const sectionIds = new Set([...knowledge.map((item) => item.sectionId), ...sectionIndex.keys()].filter((id) => sectionIndex.has(id)));
  const byDocument = new Map();
  for (const id of sectionIds) {
    const section = sectionIndex.get(id);
    const related = tests.filter((test) => test.sectionIds.includes(id));
    const skill = related.length ? average(related.map((test) => test.skillValue)) : null;
    const cell = { sectionId: id, label: section.label, short: id.replace(/^[a-z]+_/, '').slice(0, 8), n: related.length, skill, skillLabel: skill === null ? 'not evaluated' : formatScore(skill), start: section.start ?? 0 };
    cell.title = `${section.documentId} › ${section.label}: ${cell.n ? `${cell.skillLabel} across ${cell.n} question${cell.n === 1 ? '' : 's'}` : 'no evaluated questions'}`;
    byDocument.set(section.documentId, [...(byDocument.get(section.documentId) ?? []), cell]);
  }
  return [...byDocument.entries()].sort(([left], [right]) => left.localeCompare(right, 'en')).map(([documentId, sections]) => ({ documentId, sections: sections.sort((left, right) => left.start - right.start).map(({ start, ...cell }) => cell) }));
}

function formatDisclosure(disclosure) {
  if (disclosure.skillLoadedRate === null) return undefined;
  return {
    skillLoadedRate: formatScore(disclosure.skillLoadedRate),
    meanFilesRead: disclosure.meanFilesRead.toFixed(1),
    meanBytesRead: formatBytes(disclosure.meanBytesRead),
    meanFractionLoaded: formatScore(disclosure.meanFractionLoaded),
    loadedEverythingRate: formatScore(disclosure.loadedEverythingRate),
  };
}

function formatUsage(usage) {
  if (usage.answerSecondsMedian === null && usage.meanInputTokens === null) return undefined;
  const seconds = (value) => (value === null ? '--' : `${value.toFixed(1)} s`);
  const tokens = (value) => (value === null ? '--' : Math.round(value).toLocaleString('en-US'));
  return { trials: usage.trials, medianSeconds: seconds(usage.answerSecondsMedian), p90Seconds: seconds(usage.answerSecondsP90), meanInputTokens: tokens(usage.meanInputTokens), meanOutputTokens: tokens(usage.meanOutputTokens), meanTurns: usage.meanTurns === null ? '--' : usage.meanTurns.toFixed(1) };
}

function buildProbesSection(records, summary) {
  const byProbe = groupBy(records, (record) => record.probeId);
  const rate = (value) => (value === null || value === undefined ? '--' : formatScore(value));
  return {
    summary: { total: summary?.total ?? byProbe.size, correctRefusalRate: rate(summary?.correctRefusalRate), hallucinationRate: rate(summary?.hallucinationRate), behaviorPassRate: rate(summary?.behaviorPassRate), answeredWhenExpectedRate: rate(summary?.answeredWhenExpectedRate) },
    rows: [...byProbe.entries()].map(([id, trials]) => ({
      id, question: trials[0].question, expect: trials[0].expect, passed: trials.filter((trial) => trial.passed).length, trials: trials.length,
      details: trials.map((trial) => ({ trial: trial.trial, passed: Boolean(trial.passed), refused: trial.refused, hallucinated: trial.hallucinated, answer: trial.answer ?? '', rationale: trial.rationale ?? '', behaviors: (trial.behaviors ?? []).map((behavior) => ({ text: trial.expectedBehaviors?.[behavior.index] ?? `Behavior ${behavior.index + 1}`, passed: behavior.passed, rationale: behavior.rationale })) })),
    })),
  };
}

// Fix targets ranked by expected impact: the summed shortfall of the questions whose diagnosis names the file.
function aggregateRecommendations(diagnoses, skillScoreByTest, totalQuestions) {
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
  const shortfall = (testIds) => [...testIds].reduce((sum, id) => sum + (skillScoreByTest.has(id) ? 1 - skillScoreByTest.get(id) : 0), 0);
  const points = (sum) => (totalQuestions ? sum / totalQuestions * 100 : 0);
  return [...grouped.values()]
    .map((item) => ({
      file: item.file,
      changes: [...item.recommendations.entries()]
        .map(([recommendation, testIds]) => ({ recommendation, affectedTests: testIds.size, expectedImpact: shortfall(testIds) }))
        .sort((left, right) => right.expectedImpact - left.expectedImpact || right.affectedTests - left.affectedTests || left.recommendation.localeCompare(right.recommendation, 'en')),
      category: item.categories.size === 1 ? [...item.categories.keys()][0] : 'multiple',
      affectedTests: item.testIds.size,
      expectedImpact: shortfall(item.testIds),
      potentialPoints: points(shortfall(item.testIds)),
      impact: `affects ${item.testIds.size} question${item.testIds.size === 1 ? '' : 's'}, potential +${points(shortfall(item.testIds)).toFixed(1)} pts`,
    }))
    .sort((left, right) => right.expectedImpact - left.expectedImpact || right.affectedTests - left.affectedTests || left.file.localeCompare(right.file, 'en'));
}

function buildVerdict(summary, { actionableDiagnoses, targetFiles, skillTrialScores, interval }) {
  const label = actionableDiagnoses ? `${actionableDiagnoses} actionable diagnoses across ${targetFiles} target file${targetFiles === 1 ? '' : 's'}` : 'No concrete file changes diagnosed';
  const uplift = formatPercentagePoints(summary.skillUplift, true).replace(' pp', ' percentage points');
  const clamp = (value) => Math.max(-1, Math.min(1, value));
  const range = interval?.low === null || interval?.low === undefined ? '' : ` (95% CI ${formatPercentagePoints(clamp(interval.low), true).replace(' pp', '')} to ${formatPercentagePoints(clamp(interval.high), true)})`;
  const trialRange = skillTrialScores.length > 1 ? ` Skill trial aggregates ranged from ${formatScore(Math.min(...skillTrialScores))} to ${formatScore(Math.max(...skillTrialScores))}.` : '';
  const detail = `${uplift}${range} over the model alone.${trialRange} ${summary.diagnosedFailures} question${summary.diagnosedFailures === 1 ? '' : 's'} were below perfect across the measured trials; ${actionableDiagnoses} produced concrete fix targets.`;
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

// "78.2%–89.1%" (or "+61.0 to +78.4 pp" for signed differences); undefined when no interval exists.
function formatInterval(interval, signed) {
  if (interval.low === null || interval.high === null) return undefined;
  const clamp = (value) => Math.max(signed ? -1 : 0, Math.min(1, value));
  const fixed = (value) => `${signed && clamp(value) > 0 ? '+' : ''}${(clamp(value) * 100).toFixed(1)}`;
  return signed ? `${fixed(interval.low)} to ${fixed(interval.high)} pp` : `${fixed(interval.low)}%–${fixed(interval.high)}%`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function humanize(value) {
  return String(value).replaceAll('_', ' ');
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
        stage: answer.stage ? STAGE_LABELS[answer.stage] ?? answer.stage : undefined,
        filesRead: answer.trace ? answer.trace.filesRead.map((file) => file.path) : undefined,
        skillLoaded: answer.trace?.skillLoaded,
        seconds: Number.isFinite(answer.durationSeconds) ? Number(answer.durationSeconds.toFixed(1)) : undefined,
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
