import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compareRunScores, deltaVerdict, mean, meanInterval, pairedInterval, percentile, questionStability, runStatistics, sampleStandardDeviation, tCritical, trialNoise } from '../src/stats.js';

const close = (actual, expected, epsilon = 1e-9) => assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} is not within ${epsilon} of ${expected}`);

test('looks up Student t critical values and uses the normal value from n = 120', () => {
  assert.equal(tCritical(1), 12.706);
  assert.equal(tCritical(4), 2.776);
  assert.equal(tCritical(30), 2.042);
  assert.equal(tCritical(35), 2.021);
  assert.equal(tCritical(500), 1.96);
  assert.ok(Number.isNaN(tCritical(0)));
  const values = Array.from({ length: 120 }, (_, index) => index % 2);
  const interval = meanInterval(values);
  close(interval.halfWidth, 1.96 * sampleStandardDeviation(values) / Math.sqrt(120));
});

test('computes a mean with a 95% t interval (hand-computed)', () => {
  // values 0.5, 0.7, 0.9, 1.0, 0.9: mean 0.8, deviations -.3 -.1 .1 .2 .1, squares sum 0.16, sd = sqrt(0.16/4) = 0.2
  const interval = meanInterval([0.5, 0.7, 0.9, 1.0, 0.9]);
  close(interval.mean, 0.8);
  close(interval.stdev, 0.2);
  close(interval.halfWidth, 2.776 * 0.2 / Math.sqrt(5));
  close(interval.low, 0.8 - 2.776 * 0.2 / Math.sqrt(5));
  close(interval.high, 0.8 + 2.776 * 0.2 / Math.sqrt(5));
  assert.equal(interval.n, 5);
});

test('reports no interval for fewer than two observations', () => {
  assert.deepEqual(meanInterval([0.4]), { n: 1, mean: 0.4, stdev: 0, halfWidth: null, low: null, high: null });
  assert.deepEqual(meanInterval([]), { n: 0, mean: null, stdev: null, halfWidth: null, low: null, high: null });
});

test('computes a paired difference interval from per-question differences', () => {
  // differences 0.2, 0.4, 0.0 -> mean 0.2, sd 0.2, t(2) = 4.303
  const interval = pairedInterval([0.4, 0.2, 1], [0.6, 0.6, 1]);
  close(interval.mean, 0.2);
  close(interval.stdev, 0.2);
  close(interval.halfWidth, 4.303 * 0.2 / Math.sqrt(3));
  assert.throws(() => pairedInterval([1], [1, 2]), /same length/);
});

test('estimates between-trial noise and per-question stability', () => {
  const noise = trialNoise([[1, 1, 1], [0, 1], [0.5], [0.2, 0.2]]);
  assert.equal(noise.questionsWithRepeatedTrials, 3);
  close(noise.answerVariability, 1 / 3);
  // sd of [0, 1] = sqrt(0.5); other repeated questions have sd 0
  close(noise.meanWithinQuestionStdev, Math.sqrt(0.5) / 3);
  assert.deepEqual(trialNoise([[1], [0]]), { questionsWithRepeatedTrials: 0, meanWithinQuestionStdev: null, answerVariability: null });
  assert.deepEqual(questionStability([1, 1]), { trials: 2, mean: 1, stdev: 0, min: 1, max: 1, stable: true });
  const unstable = questionStability([0, 1]);
  assert.equal(unstable.stable, false);
  close(unstable.stdev, Math.sqrt(0.5));
});

test('interpolates percentiles', () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([4], 90), 4);
  assert.equal(percentile([1, 2, 3, 4], 50), 2.5);
  close(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9.1);
});

test('judges a delta interval only when it excludes zero', () => {
  assert.equal(deltaVerdict({ low: 0.01, high: 0.2 }), 'improved');
  assert.equal(deltaVerdict({ low: -0.2, high: -0.01 }), 'regressed');
  assert.equal(deltaVerdict({ low: -0.05, high: 0.1 }), 'no significant change');
  assert.equal(deltaVerdict({ low: null, high: null }), 'no significant change');
  assert.equal(deltaVerdict(meanInterval([0.1, 0.1, 0.1])), 'improved');
  assert.equal(deltaVerdict(meanInterval([0, 0, 0])), 'no significant change');
});

test('compares two runs on their shared questions', () => {
  const base = new Map([['a', 0.5], ['b', 0.5], ['c', 0.5], ['only-base', 1]]);
  const head = new Map([['a', 0.9], ['b', 0.8], ['c', 0.7], ['only-head', 0]]);
  const result = compareRunScores(base, head);
  assert.deepEqual(result.ids, ['a', 'b', 'c']);
  close(result.interval.mean, 0.3);
  assert.equal(result.verdict, 'improved');
});

test('summarizes run statistics over per-question means', () => {
  const stats = runStatistics({ closedBook: [[0], [0.5, 0.5], [0]], skill: [[1, 1], [1, 0.5], [0.5]] });
  close(stats.closedBook.mean, 0.5 / 3);
  close(stats.skill.mean, (1 + 0.75 + 0.5) / 3);
  close(stats.uplift.mean, stats.skill.mean - stats.closedBook.mean);
  close(stats.skillNoise.answerVariability, 1 / 2);
  assert.equal(mean([1, 2, 3]), 2);
});
