import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { approveAll, CopilotClient, RuntimeConnection } from '@github/copilot-sdk';

import { TraceCollector } from './trace.js';

export class CopilotSdkRunError extends Error {}

export class CopilotSdkRunner {
  constructor(config = {}, dependencies = {}) {
    this.config = {
      model: 'gpt-5.6-sol',
      reasoningEffort: 'medium',
      timeoutSeconds: 600,
      maxTimeoutRetries: 1,
      isolatedHome: undefined,
      progress: undefined,
      ...config,
    };
    this.createClient = dependencies.createClient ?? ((options) => new CopilotClient(options));
    this.clientPromise = undefined;
  }

  async run(workspace, prompt) {
    const startedAt = performance.now();
    const client = await this.#client();
    const skillDirectories = await projectSkillDirectories(workspace);
    const invocation = explicitSkillInvocation(prompt, skillDirectories);
    for (let attempt = 0; attempt <= this.config.maxTimeoutRetries; attempt += 1) {
      const session = await client.createSession({
        availableTools: ['builtin:*'],
        excludedTools: ['shell', 'write', 'url'],
        enableConfigDiscovery: false,
        enableSessionStore: false,
        enableSkills: skillDirectories.length > 0,
        memory: { enabled: false },
        model: this.config.model,
        onPermissionRequest: approveAll,
        reasoningEffort: this.config.reasoningEffort,
        skillDirectories,
        skipCustomInstructions: true,
        workingDirectory: path.resolve(workspace),
        ...(invocation ? {
          agent: 'skillfid-explicit',
          customAgents: [{ name: 'skillfid-explicit', prompt: 'Answer the user directly and follow the preloaded skill instructions.', skills: [invocation.name], tools: null }],
        } : {}),
      });
      const collector = new TraceCollector({ workspace, skillsAvailable: skillDirectories.length > 0, preloadedSkill: invocation ? { name: invocation.name, path: path.join(invocation.directory, 'SKILL.md') } : undefined });
      const unsubscribe = session.on?.((event) => { try { collector.handle(event); } catch { /* tracing must never fail an answer */ } });
      try {
        const response = await session.sendAndWait({ prompt: invocation?.prompt ?? prompt }, this.config.timeoutSeconds * 1000);
        const answer = response?.data.content?.trim();
        if (!answer) throw new CopilotSdkRunError('Copilot SDK returned no assistant message');
        const trace = await collector.finalize();
        return { answer, stderr: '', exitCode: 0, durationSeconds: (performance.now() - startedAt) / 1000, trace };
      } catch (error) {
        if (!isTimeout(error) || attempt === this.config.maxTimeoutRetries) throw new CopilotSdkRunError(error instanceof Error ? error.message : String(error), { cause: error });
        this.config.progress?.({ type: 'retry', message: `Copilot timed out after ${this.config.timeoutSeconds} seconds; retrying (timeout retry ${attempt + 1}/${this.config.maxTimeoutRetries})`, details: { workspace: path.basename(workspace), attempt: attempt + 1, maxAttempts: this.config.maxTimeoutRetries } });
      } finally {
        unsubscribe?.();
        await session.disconnect();
      }
    }
    throw new CopilotSdkRunError('Copilot SDK timeout attempts exhausted');
  }

  async listSkills(workspace) {
    const client = await this.#client();
    const skillDirectories = await projectSkillDirectories(workspace);
    const session = await client.createSession({
      availableTools: [],
      enableConfigDiscovery: false,
      enableSessionStore: false,
      enableSkills: skillDirectories.length > 0,
      memory: { enabled: false },
      onPermissionRequest: approveAll,
      skillDirectories,
      skipCustomInstructions: true,
      workingDirectory: path.resolve(workspace),
    });
    try {
      const result = await session.rpc.skills.list();
      return result.skills.map((skill) => ({ ...skill, source: skillDirectories.includes(path.dirname(skill.path ?? '')) ? 'project' : skill.source }));
    } finally {
      await session.disconnect();
    }
  }

  async version() {
    const status = await (await this.#client()).getStatus();
    return `GitHub Copilot CLI ${status.version}.`;
  }

  async close() {
    if (!this.clientPromise) return;
    let client;
    try { client = await this.clientPromise; }
    catch { this.clientPromise = undefined; return; }
    this.clientPromise = undefined;
    await client.forceStop();
  }

  async #client() {
    this.clientPromise ??= this.#startClient();
    return this.clientPromise;
  }

  async #startClient() {
    const options = {
      baseDirectory: this.config.isolatedHome ? path.resolve(this.config.isolatedHome) : undefined,
      logLevel: 'error',
    };
    if (this.config.executable) options.connection = RuntimeConnection.forStdio({ path: path.resolve(this.config.executable) });
    const client = this.createClient(options);
    await client.start();
    return client;
  }
}

async function projectSkillDirectories(workspace) {
  const root = path.resolve(workspace, '.github', 'skills');
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name)).sort();
}

function explicitSkillInvocation(prompt, skillDirectories) {
  const match = /^\/([^\s]+)\s*(?:\n+|$)/.exec(prompt);
  if (!match) return undefined;
  const directory = skillDirectories.find((item) => path.basename(item) === match[1]);
  if (!directory) return undefined;
  return { name: match[1], directory, prompt: prompt.slice(match[0].length) };
}

function isTimeout(error) {
  return error instanceof Error && /timeout|timed out/i.test(error.message);
}