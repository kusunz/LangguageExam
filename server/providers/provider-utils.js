function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createProviderError(message, extra = {}) {
  const error = new Error(message);
  Object.assign(error, extra);
  return error;
}

function extractMessageText(message) {
  if (!message) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const part of content) {
    if (!part) continue;
    if (typeof part === 'string') { text += part; continue; }
    if (typeof part.text === 'string') { text += part.text; }
  }
  return text;
}

module.exports = { parsePositiveInt, createProviderError, extractMessageText };