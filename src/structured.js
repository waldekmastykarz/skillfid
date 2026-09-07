import { InvalidStructuredResponse, parseJsonObject } from './json.js';

export { InvalidStructuredResponse, parseJsonObject };

export async function runStructured({ runner, workspace, prompt, validator, maxAttempts = 2 }) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('maxAttempts must be at least 1');
  }

  let currentPrompt = prompt;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await runner.run(workspace, currentPrompt);
    try {
      return validator(response.answer);
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        currentPrompt = [
          prompt,
          '',
          'Your previous response was invalid. Repair it while preserving all valid content:',
          error.message,
          '',
          'PREVIOUS RESPONSE:',
          response.answer,
          'END PREVIOUS RESPONSE',
          '',
          'Return exactly one corrected JSON object. Do not omit valid items. Do not use Markdown fences or add text before or after the object.',
        ].join('\n');
      }
    }
  }
  throw new InvalidStructuredResponse(`Model did not return a valid structured response after ${maxAttempts} attempts: ${lastError?.message}`);
}