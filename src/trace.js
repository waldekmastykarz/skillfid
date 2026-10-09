import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const READ_TOOLS = new Set(['view', 'read', 'read_file', 'read_text_file', 'cat', 'open_file']);
const TARGET_KEYS = ['path', 'file_path', 'filePath', 'file', 'skill', 'pattern', 'query', 'url'];
const SKILLS_PREFIX = '.github/skills/';
const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.tar', '.woff', '.woff2', '.ttf', '.otf', '.mp4', '.mov', '.mp3', '.wasm', '.bin']);
export const LOADED_EVERYTHING_FRACTION = 0.9;
export const LOADED_EVERYTHING_MIN_FILES = 3;

// Collects tool, skill and usage events from one Copilot session into a compact trial trace.
// Unknown or malformed events are ignored so SDK additions never break an evaluation.
export class TraceCollector {
  constructor({ workspace, skillsAvailable = false, preloadedSkill } = {}) {
    this.workspace = workspace ? path.resolve(workspace) : undefined;
    this.skillsAvailable = skillsAvailable;
    this.skillName = preloadedSkill?.name;
    this.skillInvoked = Boolean(preloadedSkill);
    this.reads = preloadedSkill?.path ? [{ callId: undefined, path: preloadedSkill.path }] : [];
    this.failedCalls = new Set();
    this.toolCalls = [];
    this.turns = 0;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.cachedTokens = 0;
    this.sawCache = false;
  }

  handle(event) {
    const data = event?.data;
    switch (event?.type) {
      case 'tool.execution_start': return this.#toolStarted(data);
      case 'tool.execution_complete':
        if (data?.success === false && data?.toolCallId) this.failedCalls.add(data.toolCallId);
        return undefined;
      case 'skill.invoked':
        this.skillInvoked = true;
        this.skillName ??= typeof data?.name === 'string' ? data.name : undefined;
        if (typeof data?.path === 'string') this.reads.push({ callId: undefined, path: data.path });
        return undefined;
      case 'assistant.turn_start': this.turns += 1; return undefined;
      case 'assistant.usage':
        this.inputTokens += finiteNumber(data?.inputTokens);
        this.outputTokens += finiteNumber(data?.outputTokens);
        if (data?.cacheReadTokens !== undefined) { this.sawCache = true; this.cachedTokens += finiteNumber(data.cacheReadTokens); }
        return undefined;
      default: return undefined;
    }
  }

  #toolStarted(data) {
    const name = typeof data?.toolName === 'string' ? data.toolName : undefined;
    if (!name) return;
    const args = data.arguments && typeof data.arguments === 'object' ? data.arguments : {};
    const target = TARGET_KEYS.map((key) => args[key]).find((value) => typeof value === 'string' && value);
    this.toolCalls.push({ name, ...(target ? { target } : {}) });
    if (name === 'skill' && typeof args.skill === 'string') { this.skillInvoked = true; this.skillName ??= args.skill; }
    if (READ_TOOLS.has(name)) {
      const file = args.path ?? args.file_path ?? args.filePath ?? args.file;
      if (typeof file === 'string' && file) this.reads.push({ callId: data.toolCallId, path: file });
    }
  }

  // Resolves workspace-relative paths and file sizes after the session ends.
  async finalize() {
    const roots = await workspaceRoots(this.workspace);
    const filesRead = [];
    const seen = new Set();
    for (const read of this.reads) {
      if (read.callId && this.failedCalls.has(read.callId)) continue;
      const relative = relativeToWorkspace(read.path, roots);
      if (!relative || seen.has(relative)) continue;
      seen.add(relative);
      filesRead.push({ path: relative, bytes: await fileSize(path.resolve(roots[0], relative)) });
    }
    // A skill invoked by name may report only that name, whose directory can differ from the frontmatter name; only
    // add a SKILL.md read when none was recorded and the guessed file really exists.
    if (this.skillInvoked && this.skillName && !filesRead.some((file) => /^\.github\/skills\/[^/]+\/SKILL\.md$/.test(file.path))) {
      const relative = `${SKILLS_PREFIX}${this.skillName}/SKILL.md`;
      const bytes = await fileSize(path.resolve(roots[0], relative));
      if (bytes > 0) filesRead.push({ path: relative, bytes });
    }
    const skillMdRead = filesRead.some((file) => /^\.github\/skills\/[^/]+\/SKILL\.md$/.test(file.path));
    const skillName = this.skillName ?? filesRead.map((file) => /^\.github\/skills\/([^/]+)\//.exec(file.path)?.[1]).find(Boolean);
    const skillLoaded = this.skillInvoked || skillMdRead ? true : this.skillsAvailable ? false : null;
    const trace = { skillLoaded, ...(skillLoaded && skillName ? { skillName } : {}), filesRead, toolCalls: this.toolCalls, turns: this.turns, inputTokens: this.inputTokens, outputTokens: this.outputTokens };
    if (this.sawCache) trace.cachedTokens = this.cachedTokens;
    return trace;
  }
}

async function workspaceRoots(workspace) {
  if (!workspace) return [process.cwd()];
  const roots = [workspace];
  try { const real = await realpath(workspace); if (real !== workspace) roots.push(real); } catch { /* the workspace may already be gone */ }
  return roots;
}

function relativeToWorkspace(file, roots) {
  const candidate = path.isAbsolute(file) ? file : path.resolve(roots[0], file);
  for (const root of roots) {
    const relative = path.relative(root, candidate);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative.split(path.sep).join('/');
  }
  return undefined;
}

async function fileSize(file) {
  try { const info = await stat(file); return info.isFile() ? info.size : 0; }
  catch { return 0; }
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

// Lists a skill directory with sizes and hashes. Content is included for text files so evidence can be located in them.
export async function inventorySkill(root) {
  const files = [];
  async function walk(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(entryPath);
      else if (entry.isFile()) {
        const buffer = await readFile(entryPath);
        const binary = BINARY_EXTENSIONS.has(path.extname(entry.name).toLowerCase());
        files.push({ path: path.relative(root, entryPath).split(path.sep).join('/'), bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex'), ...(binary ? {} : { content: buffer.toString('utf8') }) });
      }
    }
  }
  await walk(path.resolve(root));
  return files;
}

export function skillFileHashes(files) {
  return Object.fromEntries(files.map((file) => [file.path, file.sha256]));
}

// Skill-relative paths of the skill files a trace read (".github/skills/<name>/references/a.md" becomes "references/a.md").
export function skillFilesRead(trace) {
  return (trace?.filesRead ?? []).flatMap((file) => {
    if (!file.path.startsWith(SKILLS_PREFIX)) return [];
    const rest = file.path.slice(SKILLS_PREFIX.length);
    const slash = rest.indexOf('/');
    return slash === -1 ? [] : [{ path: rest.slice(slash + 1), bytes: file.bytes }];
  });
}

// Progressive disclosure for one skill answer: how much of the skill directory the agent actually loaded.
export function skillDisclosure(trace, skillFiles) {
  if (!trace || trace.skillLoaded === null || trace.skillLoaded === undefined) return undefined;
  const sizes = new Map(skillFiles.map((file) => [file.path, file.bytes]));
  const totalBytes = skillFiles.reduce((sum, file) => sum + file.bytes, 0);
  const read = [...new Map(skillFilesRead(trace).filter((file) => sizes.has(file.path)).map((file) => [file.path, file])).values()];
  const bytesRead = read.reduce((sum, file) => sum + sizes.get(file.path), 0);
  const fractionOfSkillLoaded = totalBytes ? bytesRead / totalBytes : 0;
  return { skillLoaded: trace.skillLoaded, filesRead: read.length, bytesRead, fractionOfSkillLoaded, loadedEverything: fractionOfSkillLoaded >= LOADED_EVERYTHING_FRACTION && read.length >= LOADED_EVERYTHING_MIN_FILES };
}

export function summarizeDisclosure(disclosures) {
  const present = disclosures.filter(Boolean);
  if (!present.length) return { meanFilesRead: null, meanBytesRead: null, meanFractionLoaded: null, loadedEverythingRate: null, skillLoadedRate: null };
  const average = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    meanFilesRead: average(present.map((item) => item.filesRead)),
    meanBytesRead: average(present.map((item) => item.bytesRead)),
    meanFractionLoaded: average(present.map((item) => item.fractionOfSkillLoaded)),
    loadedEverythingRate: present.filter((item) => item.loadedEverything).length / present.length,
    skillLoadedRate: present.filter((item) => item.skillLoaded).length / present.length,
  };
}
