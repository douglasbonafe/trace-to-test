// ponytail: regex redaction only catches well-formed emails, phones (NANP/E.164-ish), 13-19 digit cards,
// and sk-/Bearer secrets. Names, addresses, free-form IDs and obfuscated secrets slip through.
// Upgrade path: an NER/Presidio-style detector plus an allowlist of fields that may be kept.
const RULES: [RegExp, string][] = [
  [/\bsk-[A-Za-z0-9_-]{8,}/g, '[API_KEY]'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/g, 'Bearer [TOKEN]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, '[EMAIL]'],
  [/\b(?:\d[ -]?){12,18}\d\b/g, '[CARD]'],
  [/(?:\+\d{1,3}[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, '[PHONE]'],
];

export const redact = (s: string) => RULES.reduce((acc, [re, rep]) => acc.replace(re, rep), s);

// Walk values (not the serialized JSON) so escapes like "\n4111..." can't hide a match.
export function redactDeep<T>(v: T): T {
  if (typeof v === 'string') return redact(v) as T;
  if (Array.isArray(v)) return v.map(redactDeep) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x)])) as T;
  return v;
}
