'use strict';

// Redaction for optional memory sidecars. GemAir keeps the original transcript
// locally, but durable OpenJarvis memories should not retain obvious secrets or
// direct contact identifiers unless the user explicitly opts out.

const RULES = [
  { name: 'secret', pattern: /\b(?:sk|rk|ghp|gho|github_pat|xox[baprs]-|AIza|AKIA)[A-Za-z0-9_\-]{8,}\b/gi, replacement: '[redacted secret]' },
  { name: 'bearer', pattern: /\bBearer\s+[A-Za-z0-9._\-~+/]+=*/gi, replacement: 'Bearer [redacted token]' },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, replacement: '[redacted token]' },
  { name: 'email', pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, replacement: '[redacted email]' },
  { name: 'card', pattern: /(?<!\d)(?:\d[ -]*?){13,19}(?!\d)/g, replacement: '[redacted number]' },
  { name: 'phone', pattern: /(?<!\d)(?:\+?\d[\d ()-]{7,}\d)(?!\d)/g, replacement: '[redacted phone]' }
];

function redactSensitiveText(value) {
  let text = String(value == null ? '' : value);
  const categories = new Set();
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(text)) {
      categories.add(rule.name);
      rule.pattern.lastIndex = 0;
      text = text.replace(rule.pattern, rule.replacement);
    }
  }
  return { text, redacted: categories.size > 0, categories: [...categories] };
}

module.exports = { redactSensitiveText };
