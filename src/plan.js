import { loadSections, resolveBuildSettings } from './dataset-build.js';

// Heuristics measured on earlier builds of a 12.8k-word playbook: ~15.5 knowledge items per 1,000 characters, about 0.27
// questions per item, ~3.3 calls per section for inventory and generation, ~4.2 calls per question for the oracle and judges.
const ITEMS_PER_CHAR = 0.0155;
const QUESTIONS_PER_ITEM = 0.27;
const CALLS_PER_SECTION = 3.3;
const CALLS_PER_QUESTION = 4.2;
const SECONDS_PER_CALL = { low: 6, high: 14 };
const IMPORTANCE_SHARE = { high: 0.75, medium: 0.235, low: 0.015 };

export async function planDataset({ corpusPath, options = {} }) {
  const settings = resolveBuildSettings(options);
  const { documents, sections } = await loadSections(corpusPath, settings);
  const sizes = sections.map((section) => section.content.length).sort((left, right) => left - right);
  const characters = sizes.reduce((sum, size) => sum + size, 0);
  const share = settings.importance.reduce((sum, tier) => sum + IMPORTANCE_SHARE[tier], 0);
  const knowledgeItems = Math.round(characters * ITEMS_PER_CHAR * share);
  const questions = Math.round(knowledgeItems * QUESTIONS_PER_ITEM);
  const copilotCalls = Math.round(sections.length * CALLS_PER_SECTION + questions * CALLS_PER_QUESTION);
  const minutes = (seconds) => Math.max(1, Math.round((copilotCalls * seconds) / settings.concurrency / 60));
  const warnings = [];
  const dense = sections.filter((section) => section.content.length > settings.maxSectionChars * 0.8);
  if (dense.length) warnings.push(`${dense.length} section${dense.length === 1 ? ' is' : 's are'} close to --max-section-chars (${settings.maxSectionChars}); dense sections need more inventory passes and may be split automatically.`);
  if (sections.length < settings.concurrency) warnings.push(`Only ${sections.length} sections for concurrency ${settings.concurrency}; most calls will wait on a few sections.`);
  if (sections.length > 400) warnings.push('Large corpus: consider --profile standard or --profile quick to limit calibration cost.');
  if (copilotCalls > 5000) warnings.push('Over 5,000 Copilot calls expected; make sure your Copilot plan allows this volume.');
  return {
    documents: documents.length,
    sections: sections.length,
    characters,
    estimatedTokens: Math.round(characters / 4),
    sectionChars: { min: sizes[0], median: sizes[Math.floor(sizes.length / 2)], max: sizes.at(-1) },
    largestSections: [...sections].sort((left, right) => right.content.length - left.content.length).slice(0, 3).map((section) => ({ label: section.label, characters: section.content.length })),
    concurrency: settings.concurrency,
    importance: settings.importance,
    estimate: { knowledgeItems, questions, copilotCalls, minutes: { low: minutes(SECONDS_PER_CALL.low), high: minutes(SECONDS_PER_CALL.high) } },
    warnings,
  };
}
