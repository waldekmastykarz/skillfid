export function stableStringify(value, space) {
  return JSON.stringify(sortValue(value), null, space);
}

export function parseJsonObject(response, label = 'Response') {
  let value;
  try {
    value = JSON.parse(response);
  } catch (error) {
    throw new InvalidStructuredResponse(`${label} is not valid JSON: ${error.message}`);
  }
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new InvalidStructuredResponse(`${label} must be a JSON object`);
  }
  return value;
}

export class InvalidStructuredResponse extends Error {}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
  }
  return value;
}