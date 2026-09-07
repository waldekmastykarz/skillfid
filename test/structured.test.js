import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseJsonObject, runStructured } from '../src/structured.js';

test('repairs an invalid structured response', async () => {
  const answers = ['not json', '{"ok":true}'];
  const prompts = [];
  const runner = { run: async (_workspace, prompt) => { prompts.push(prompt); return { answer: answers.shift() }; } };
  assert.deepEqual(await runStructured({ runner, prompt: 'Return JSON', validator: parseJsonObject, maxAttempts: 2 }), { ok: true });
  assert.match(prompts[1], /PREVIOUS RESPONSE:\nnot json\nEND PREVIOUS RESPONSE/);
});

test('stops at the structured response attempt limit', async () => {
  const runner = { run: async () => ({ answer: 'bad' }) };
  await assert.rejects(runStructured({ runner, prompt: 'Return JSON', validator: parseJsonObject, maxAttempts: 1 }), /after 1 attempts/);
});