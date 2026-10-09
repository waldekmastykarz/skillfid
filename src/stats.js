// Two-sided 95% Student t critical values for 1..30 degrees of freedom, then coarser anchors; the normal value applies from n >= 120.
const T_CRITICAL = [NaN, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042];
const T_ANCHORS = [[40, 2.021], [60, 2.0], [80, 1.99], [100, 1.984], [119, 1.98]];
const NORMAL_CRITICAL = 1.96;
export const SCORE_TOLERANCE = 1e-9;

export function tCritical(degreesOfFreedom) {
  if (!Number.isInteger(degreesOfFreedom) || degreesOfFreedom < 1) return NaN;
  if (degreesOfFreedom < T_CRITICAL.length) return T_CRITICAL[degreesOfFreedom];
  // Round the degrees of freedom up to the next anchor so intervals stay slightly conservative.
  for (const [limit, value] of T_ANCHORS) if (degreesOfFreedom <= limit) return value;
  return NORMAL_CRITICAL;
}

export function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN;
}

export function sampleStandardDeviation(values) {
  if (values.length < 2) return 0;
  const center = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - center) ** 2, 0) / (values.length - 1));
}

// Mean with a 95% confidence interval; bounds are null when fewer than two observations exist.
export function meanInterval(values) {
  const n = values.length;
  if (!n) return { n, mean: null, stdev: null, halfWidth: null, low: null, high: null };
  const center = mean(values);
  const stdev = sampleStandardDeviation(values);
  if (n < 2) return { n, mean: center, stdev, halfWidth: null, low: null, high: null };
  const halfWidth = (n >= 120 ? NORMAL_CRITICAL : tCritical(n - 1)) * stdev / Math.sqrt(n);
  return { n, mean: center, stdev, halfWidth, low: center - halfWidth, high: center + halfWidth };
}

// Paired difference (head minus base) over equally long arrays of per-question values.
export function pairedInterval(base, head) {
  if (base.length !== head.length) throw new Error('Paired samples must have the same length');
  return meanInterval(head.map((value, index) => value - base[index]));
}

// Between-trial noise: mean within-question standard deviation and the share of questions whose trial scores differ.
export function trialNoise(trialScoresByQuestion) {
  const repeated = trialScoresByQuestion.filter((scores) => scores.length > 1);
  if (!repeated.length) return { questionsWithRepeatedTrials: 0, meanWithinQuestionStdev: null, answerVariability: null };
  const varying = repeated.filter((scores) => Math.max(...scores) - Math.min(...scores) > SCORE_TOLERANCE);
  return {
    questionsWithRepeatedTrials: repeated.length,
    meanWithinQuestionStdev: mean(repeated.map(sampleStandardDeviation)),
    answerVariability: varying.length / repeated.length,
  };
}

export function questionStability(scores) {
  if (!scores.length) return { trials: 0, mean: null, stdev: null, min: null, max: null, stable: true };
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  return { trials: scores.length, mean: mean(scores), stdev: sampleStandardDeviation(scores), min, max, stable: max - min <= SCORE_TOLERANCE };
}

// Linear-interpolated percentile (p in 0..100) of numeric values.
export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

// Judges a paired delta interval: significant only when the 95% interval excludes zero.
export function deltaVerdict(interval) {
  if (interval.low === null || interval.high === null) return 'no significant change';
  if (interval.low > SCORE_TOLERANCE) return 'improved';
  if (interval.high < -SCORE_TOLERANCE) return 'regressed';
  return 'no significant change';
}

// Compares two runs given per-question mean scores keyed by test id; only shared questions are paired.
export function compareRunScores(baseScores, headScores) {
  const ids = [...baseScores.keys()].filter((id) => headScores.has(id)).sort();
  const base = ids.map((id) => baseScores.get(id));
  const head = ids.map((id) => headScores.get(id));
  const interval = pairedInterval(base, head);
  return { ids, interval, verdict: deltaVerdict(interval) };
}

// Headline statistics for one run, computed over per-question mean scores.
// closedBook and skill are arrays of per-question trial score arrays aligned by question.
export function runStatistics({ closedBook, skill }) {
  const closedMeans = closedBook.map(mean);
  const skillMeans = skill.map(mean);
  const paired = closedBook.length === skill.length && skill.length > 0;
  return {
    closedBook: meanInterval(closedMeans),
    skill: meanInterval(skillMeans),
    uplift: paired ? pairedInterval(closedMeans, skillMeans) : meanInterval([]),
    skillNoise: trialNoise(skill),
    closedBookNoise: trialNoise(closedBook),
  };
}
