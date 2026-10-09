import { EXIT_CODES, SkillfidError } from './errors.js';

const DUPLICATE_OVERLAP = 0.5;
const DUPLICATE_SIMILARITY = 0.6;
// Residual passes from this number onward may accept low-importance additions as diminishing returns.
const TOLERANCE_FROM_PASS = 2;

export class ConvergenceError extends SkillfidError {
  constructor(message, { kind = 'inventory', details, remedy } = {}) {
    super(message, {
      code: kind === 'audit' ? 'AUDIT_NOT_CONVERGED' : kind === 'questions' ? 'QUESTIONS_NOT_CONVERGED' : 'INVENTORY_NOT_CONVERGED',
      exitCode: EXIT_CODES.incomplete,
      details,
      remedy: remedy ?? 'Finished sections are cached. Re-run with a higher --max-residual-passes (or --max-audit-passes), or a smaller --max-section-chars so this section is split earlier.',
    });
  }
}

export function statementTokens(statement) {
  return new Set(statement.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

export function jaccard(left, right) {
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

function overlapRatio(left, right) {
  const overlap = Math.min(left.end, right.end) - Math.max(left.start, right.start);
  return overlap <= 0 ? 0 : overlap / Math.min(left.end - left.start, right.end - right.start);
}

// A candidate is not new when it restates an item already supported by the same source passage.
export function novelItems({ items, evidence, candidates, candidateEvidence }) {
  const evidenceById = new Map([...evidence, ...candidateEvidence].map((record) => [record.evidenceId, record]));
  const known = items.map((item) => ({ id: item.knowledgeId, text: item.statement.trim().toLowerCase(), tokens: statementTokens(item.statement), spans: item.evidenceIds.map((id) => evidenceById.get(id)).filter(Boolean) }));
  const knownIds = new Set(known.map((item) => item.id));
  const additions = [];
  const duplicates = [];
  for (const candidate of candidates) {
    if (knownIds.has(candidate.knowledgeId)) { duplicates.push(candidate); continue; }
    const text = candidate.statement.trim().toLowerCase();
    const tokens = statementTokens(candidate.statement);
    const spans = candidate.evidenceIds.map((id) => evidenceById.get(id)).filter(Boolean);
    const restated = known.some((item) => item.text === text || (jaccard(tokens, item.tokens) >= DUPLICATE_SIMILARITY && spans.some((span) => item.spans.some((other) => overlapRatio(span, other) >= DUPLICATE_OVERLAP))));
    if (restated) { duplicates.push(candidate); continue; }
    additions.push(candidate);
    known.push({ id: candidate.knowledgeId, text, tokens, spans });
    knownIds.add(candidate.knowledgeId);
  }
  return { additions, duplicates };
}

export function isDiminishing(additions, pass) {
  return additions.length > 0 && pass >= TOLERANCE_FROM_PASS && additions.every((item) => item.importance === 'low');
}

function summarizePass(kind, pass, residual, additions, duplicates, tolerated) {
  const importance = {};
  for (const item of additions) importance[item.importance] = (importance[item.importance] ?? 0) + 1;
  return { kind, pass, returned: residual.items.length, added: additions.length, duplicates: duplicates.length, importance, tolerated, reason: residual.reason };
}

function addToInventory(state, additions, residual) {
  const evidenceIds = new Set(additions.flatMap((item) => item.evidenceIds));
  state.items.push(...additions);
  state.evidence.push(...residual.evidence.filter((record) => evidenceIds.has(record.evidenceId)));
}

// Extracts an inventory, then re-checks it until the model reports nothing new. A section that keeps finding items gets a
// larger pass budget once before failing, so one dense section does not need a global rerun.
export async function convergeInventory({ extract, label, settings, reporter }) {
  const initial = await extract([], []);
  const state = { items: [...initial.items], evidence: [...initial.evidence] };
  const history = [{ kind: 'initial', pass: 0, returned: initial.items.length, added: initial.items.length, duplicates: 0, importance: {}, tolerated: false, reason: initial.reason }];
  let cleanPasses = 0;
  let pass = 0;
  let recovered = false;
  let lastResidual;
  let budget = settings.maxResidualPasses;
  const ceiling = settings.escalate ? settings.maxResidualPasses * 2 : budget;
  while (cleanPasses < settings.cleanResidualPasses) {
    pass += 1;
    if (pass > budget) {
      if (budget >= ceiling) throw new ConvergenceError(`Inventory did not converge for ${label} after ${budget} passes`, { details: { label, budget, history, itemsFound: state.items.length } });
      reporter.warn(`${label} did not settle in ${budget} passes; extending to ${ceiling}`);
      budget = ceiling;
    }
    reporter.stage('Checking coverage');
    const residual = await extract(state.items, state.evidence);
    lastResidual = residual;
    const { additions, duplicates } = novelItems({ items: state.items, evidence: state.evidence, candidates: residual.items, candidateEvidence: residual.evidence });
    const tolerated = isDiminishing(additions, pass);
    history.push(summarizePass('residual', pass, residual, additions, duplicates, tolerated));
    if (additions.length) {
      recovered = true;
      addToInventory(state, additions, residual);
      reporter.results({ items: state.items.length });
    }
    cleanPasses = !additions.length || tolerated ? cleanPasses + 1 : 0;
  }
  return { initial, items: state.items, evidence: state.evidence, recovered, lastResidual, history };
}

// After residual recovery, an independent audit must find nothing new before questions are generated.
export async function auditInventory({ extract, inventory, label, settings, reporter }) {
  const state = { items: [...inventory.items], evidence: [...inventory.evidence] };
  const recoveredKnowledgeIds = [];
  const history = [];
  let audit = inventory.lastResidual;
  let converged = !inventory.recovered;
  for (let pass = 1; inventory.recovered && pass <= settings.maxAuditPasses; pass += 1) {
    reporter.stage('Auditing completeness');
    audit = await extract(state.items, state.evidence);
    const { additions, duplicates } = novelItems({ items: state.items, evidence: state.evidence, candidates: audit.items, candidateEvidence: audit.evidence });
    const tolerated = isDiminishing(additions, TOLERANCE_FROM_PASS);
    history.push(summarizePass('audit', pass, audit, additions, duplicates, tolerated));
    if (!additions.length) { converged = true; break; }
    recoveredKnowledgeIds.push(...additions.map((item) => item.knowledgeId));
    addToInventory(state, additions, audit);
    reporter.results({ items: state.items.length });
    if (tolerated) { converged = true; break; }
  }
  if (!converged) throw new ConvergenceError(`Completeness audit did not converge for ${label} after ${settings.maxAuditPasses} passes`, { kind: 'audit', details: { label, budget: settings.maxAuditPasses, history: [...inventory.history, ...history], itemsFound: state.items.length } });
  return { items: state.items, evidence: state.evidence, audit, recoveredKnowledgeIds, history };
}
