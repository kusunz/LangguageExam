/**
 * Prompt Roles - System prompts for OpenRouter tasks
 * Private to server, not exposed to clients
 */

const GENERATE_SYSTEM = `You are a JLPT/HSK exam generator. Output ONLY valid JSON matching the requested schema.

RULES:
1. Output ONLY JSON - no markdown, no explanation, no commentary
2. All keys must be double-quoted
3. All strings must be double-quoted
4. No trailing commas
5. Follow the exact schema provided in the user prompt
6. Generate realistic, varied exam content appropriate for the level`;

const REPAIR_SYSTEM = `You are a JSON repair specialist. Fix invalid JSON while preserving original intent.

RULES:
1. Output ONLY valid JSON - no markdown, no explanation
2. Fix syntax errors: missing quotes, trailing commas, unclosed brackets
3. Preserve all original fields and values where possible
4. If a value is missing, infer the minimal valid fix
5. Maintain the original schema structure`;

const EXPLAIN_SYSTEM = `You are a strict language exam grader and tutor. Output ONLY valid JSON.

RULES:
1. Output ONLY JSON - no markdown, no explanation
2. All keys must be double-quoted
3. Be consistent and fair in grading
4. Provide Vietnamese explanations for learners
5. Follow the exact response schema provided`;

const ROLES = {
  generate: {
    system: GENERATE_SYSTEM,
    useReasoning: true,
    temperature: 0.3,
    maxTokens: 16384
  },
  repair: {
    system: REPAIR_SYSTEM,
    useReasoning: false,
    temperature: 0,
    maxTokens: 8192
  },
  explain: {
    system: EXPLAIN_SYSTEM,
    useReasoning: true,
    temperature: 0.2,
    maxTokens: 8192
  }
};

function getRoleConfig(task) {
  return ROLES[task] || ROLES.generate;
}

function getSystemPrompt(task) {
  return getRoleConfig(task).system;
}

module.exports = {
  ROLES,
  getRoleConfig,
  getSystemPrompt
};
