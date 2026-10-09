import { summarizeProbes } from './probes.js';
import { summarizeStages } from './staging.js';
import { mean, percentile, questionStability, runStatistics } from './stats.js';
import { summarizeDisclosure } from './trace.js';

// Trial scores per question, aligned with testIds, for one condition.
export function trialScores(answers, testIds, condition) {
  const scores = new Map();
  for (const answer of answers) if (answer.condition === condition) scores.set(answer.testId, [...(scores.get(answer.testId) ?? []), answer.score]);
  return testIds.map((id) => scores.get(id) ?? []);
}

export function buildStatistics({ testIds, answers }) {
  const closedBook = trialScores(answers, testIds, 'closedBook');
  const skill = trialScores(answers, testIds, 'skill');
  const keep = testIds.map((_, index) => index).filter((index) => closedBook[index].length && skill[index].length);
  const statistics = runStatistics({ closedBook: keep.map((index) => closedBook[index]), skill: keep.map((index) => skill[index]) });
  return { ...statistics, stability: keep.map((index) => ({ testId: testIds[index], ...questionStability(skill[index]) })) };
}

const average = (values) => (values.length ? mean(values) : null);

// Latency and token use from recorded answers; each value is null when no answer recorded it.
export function usageSummary(answers) {
  const seconds = answers.map((answer) => answer.durationSeconds).filter(Number.isFinite);
  const traces = answers.map((answer) => answer.trace).filter(Boolean);
  const input = traces.map((trace) => trace.inputTokens).filter(Number.isFinite);
  const output = traces.map((trace) => trace.outputTokens).filter(Number.isFinite);
  const cached = traces.map((trace) => trace.cachedTokens).filter(Number.isFinite);
  return {
    trials: answers.length,
    answerSecondsMedian: percentile(seconds, 50),
    answerSecondsP90: percentile(seconds, 90),
    answerSecondsMean: average(seconds),
    meanTurns: average(traces.map((trace) => trace.turns).filter(Number.isFinite)),
    meanInputTokens: average(input),
    meanOutputTokens: average(output),
    meanCachedTokens: average(cached),
    meanTotalTokens: input.length || output.length ? average(traces.map((trace) => (trace.inputTokens ?? 0) + (trace.outputTokens ?? 0))) : null,
  };
}

export function buildSummary({ datasetId, questions, totalQuestions, calibrations, answers, diagnoses, probeRecords, failUnder, selection, incremental }) {
  const testIds = questions.map((question) => question.testId);
  const statistics = buildStatistics({ testIds, answers });
  const conditionScores = { closedBook: statistics.closedBook.mean, skill: statistics.skill.mean };
  const skillAnswers = answers.filter((answer) => answer.condition === 'skill');
  const ceiling = mean(calibrations.filter((item) => testIds.includes(item.testId)).map((item) => item.score));
  const summary = {
    datasetId,
    questions: questions.length,
    conditionScores,
    datasetCeiling: ceiling,
    skillUplift: conditionScores.skill - conditionScores.closedBook,
    diagnosedFailures: diagnoses.length,
    statistics,
    failureStages: summarizeStages(skillAnswers),
    progressiveDisclosure: summarizeDisclosure(skillAnswers.map((answer) => answer.disclosure)),
    usage: { skill: usageSummary(skillAnswers), closedBook: usageSummary(answers.filter((answer) => answer.condition === 'closedBook')) },
  };
  if (questions.length < totalQuestions) { summary.partial = true; summary.subset = { questions: questions.length, of: totalQuestions, ...(selection?.sample ? { sample: selection.sample } : {}), ...(selection?.filter ? { filter: selection.filter } : {}) }; }
  if (incremental) summary.incremental = incremental;
  if (probeRecords?.length) summary.probes = summarizeProbes(probeRecords);
  if (failUnder !== undefined) summary.gate = { passed: conditionScores.skill >= failUnder - 1e-9, threshold: failUnder, score: conditionScores.skill };
  return summary;
}
