import { INITIAL_JUDGMENTS } from './dataset-core.js';

const DEFAULT_CALLS_PER_ITEM = 1;
const CALLS_PER_QUESTION = 1 + INITIAL_JUDGMENTS;

export function createDashboard({ sections, documents, concurrency }) {
  return { documents, sections, completed: 0, running: 0, failed: 0, waiting: 0, resumed: 0, calls: 0, stages: new Map(), sectionItems: new Map(), sectionCovered: new Map(), sectionGenerated: new Map(), sectionCalibrated: new Map(), estimate: { concurrency, sections: new Map() } };
}

export function datasetProgress(state) {
  const items = [...state.sectionItems.values()].reduce((sum, count) => sum + count, 0);
  const covered = [...state.sectionCovered.values()].reduce((sum, count) => sum + count, 0);
  return { done: covered, total: items, eta: estimateDatasetCalls(state.estimate), label: 'knowledge items covered' };
}

// Flat key/value status that agent progress lines print verbatim, so a poll shows stage, counts and failures at a glance.
export function datasetMetrics(state) {
  const stageCounts = {};
  for (const stage of state.stages.values()) stageCounts[stage] = (stageCounts[stage] ?? 0) + 1;
  const sum = (map) => [...map.values()].reduce((total, count) => total + count, 0);
  const metrics = { sections: `${state.completed}/${state.sections}`, running: state.running, failed: state.failed };
  if (state.resumed) metrics.reused = state.resumed;
  if (state.waiting) metrics.waiting = state.waiting;
  const stages = Object.entries(stageCounts).map(([stage, count]) => `${stage}:${count}`).join(',');
  if (stages) metrics.stages = stages;
  metrics.items = sum(state.sectionItems);
  metrics.generated = sum(state.sectionGenerated);
  metrics.calibrated = sum(state.sectionCalibrated);
  metrics.calls = state.calls;
  return metrics;
}

// Estimates remaining work in Copilot calls, which complete steadily, rather than in covered items, which only move when a whole section finishes.
export function estimateDatasetCalls({ concurrency, sections }) {
  const records = [...sections.values()];
  const done = records.reduce((sum, record) => sum + record.calls, 0);
  const inventoried = records.filter((record) => record.items !== undefined);
  const inventoriedChars = inventoried.reduce((sum, record) => sum + record.chars, 0);
  if (!records.length || !inventoried.length || !inventoriedChars || done < Math.min(concurrency, records.length)) return { done, total: undefined };
  const itemsPerChar = inventoried.reduce((sum, record) => sum + record.items, 0) / inventoriedChars;
  const callsPerItem = learnedCallsPerItem(records);
  const remaining = records.reduce((sum, record) => {
    if (record.completed) return sum;
    const items = record.items ?? record.chars * itemsPerChar;
    const predicted = fixedSectionCalls(items) + (record.questions ? CALLS_PER_QUESTION * record.questions : callsPerItem * items);
    return sum + Math.max(predicted - record.calls, record.calls ? 1 : predicted);
  }, 0);
  return { done, total: done + Math.round(remaining) };
}

function learnedCallsPerItem(records) {
  const completed = records.filter((record) => record.completed && record.items > 0);
  const completedItems = completed.reduce((sum, record) => sum + record.items, 0);
  if (completedItems) return Math.max(0, completed.reduce((sum, record) => sum + record.calls - fixedSectionCalls(record.items), 0)) / completedItems;
  const generated = records.filter((record) => record.questions && record.items > 0);
  const generatedItems = generated.reduce((sum, record) => sum + record.items, 0);
  if (generatedItems) return CALLS_PER_QUESTION * generated.reduce((sum, record) => sum + record.questions, 0) / generatedItems;
  return DEFAULT_CALLS_PER_ITEM;
}

function fixedSectionCalls(items) {
  // Initial inventory plus one clean residual pass; informational sections also need a generation call.
  return items > 0 ? 3 : 2;
}

export function countCalls(runner, onCall) {
  return {
    async run(...args) {
      try { return await runner.run(...args); }
      finally { onCall(); }
    },
  };
}

const TRANSCRIPT_FIELD_CHARS = 30_000;
const clip = (text) => (typeof text === 'string' && text.length > TRANSCRIPT_FIELD_CHARS ? `${text.slice(0, TRANSCRIPT_FIELD_CHARS)}… [${text.length - TRANSCRIPT_FIELD_CHARS} more characters]` : text);

// Keeps every prompt and response of one section in memory so a failure can be written out for diagnosis; a section that
// succeeds simply drops the log.
export function recordCalls(runner, log, role) {
  return {
    async run(workspace, prompt, ...rest) {
      const entry = { at: new Date().toISOString(), role, prompt: clip(prompt) };
      log.push(entry);
      try {
        const result = await runner.run(workspace, prompt, ...rest);
        entry.answer = clip(result?.answer);
        return result;
      } catch (error) {
        entry.error = error?.message ?? String(error);
        throw error;
      }
    },
  };
}

export function updateSectionResults(state, sectionId, { items, covered, generated, calibrated }) {
  if (items !== undefined) {
    state.sectionItems.set(sectionId, items);
    const estimate = state.estimate?.sections.get(sectionId);
    if (estimate) estimate.items = items;
  }
  if (generated) {
    const estimate = state.estimate?.sections.get(sectionId);
    if (estimate) estimate.questions = generated;
  }
  if (covered !== undefined) state.sectionCovered.set(sectionId, covered);
  if (generated !== undefined) state.sectionGenerated.set(sectionId, generated);
  if (calibrated !== undefined) state.sectionCalibrated.set(sectionId, calibrated);
}

function stageKey(text) {
  if (/audit/i.test(text)) return 'audit';
  if (/calibrat/i.test(text)) return 'calibration';
  if (/generat|prepar/i.test(text)) return 'questions';
  return 'inventory';
}

// One reporter per section ties every progress event to a human label and keeps the stage mix current. Parts of a split
// section report results under their own ID but share the parent's stage and call accounting.
export function createSectionReporter({ progress, dashboard, section, parentId = section.sectionId, label = section.label ?? section.sectionId }) {
  const emit = (event) => progress?.({ type: 'update', workflow: 'dataset', ...event, progress: datasetProgress(dashboard), metrics: datasetMetrics(dashboard) });
  return {
    label,
    stage(text) {
      dashboard.stages.set(parentId, stageKey(text));
      emit({ current: `${text} · ${label}` });
    },
    detail(text) { emit({ current: `${text} · ${label}` }); },
    warn(message) { progress?.({ type: 'warning', workflow: 'dataset', message, metrics: datasetMetrics(dashboard) }); },
    results(results) {
      updateSectionResults(dashboard, section.sectionId, results);
      emit({});
    },
    call() {
      const record = dashboard.estimate.sections.get(parentId);
      if (record) record.calls += 1;
      dashboard.calls += 1;
      emit({});
    },
    part(part) { return createSectionReporter({ progress, dashboard, section: part, parentId, label: part.label }); },
    // Called before a section is split so its own counts are replaced by those of its parts.
    forget() {
      for (const map of [dashboard.sectionItems, dashboard.sectionCovered, dashboard.sectionGenerated, dashboard.sectionCalibrated]) map.delete(section.sectionId);
    },
    finish() { dashboard.stages.delete(parentId); },
  };
}
