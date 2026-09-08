/**
 * Interpret the model's reply as either "move on" or one probe.
 *
 * The researcher-authored prompt asks for the literal move-on token or a
 * JSON object {probe_type, trigger, question}. Real models decorate that:
 * code fences, <think> blocks, curly quotes copied from the prompt's own
 * example, trailing prose. We normalise those, but we never *invent* a
 * probe — anything we cannot classify against the survey's taxonomy becomes
 * a `parse_error`, which the engine treats as "move on" and records as such.
 */

export type ParseResult =
  | { kind: 'move_on' }
  | { kind: 'probe'; probeType: string; trigger: string; question: string; flags: Record<string, unknown> }
  | { kind: 'parse_error'; reason: string };

export interface ParseOptions {
  probeTypes: string[];
  moveOnToken: string;
  maxQuestionWords: number;
}

/** Pull the assistant text out of an OpenAI-style chat completion response. */
export function extractContent(response: unknown): string | null {
  const r = response as { choices?: Array<{ message?: { content?: unknown } }> } | null;
  const content = r?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((p) => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : ''))
      .filter(Boolean);
    return parts.length ? parts.join('\n') : null;
  }
  return null;
}

/** OpenAI-style finish_reason of the first choice, if present. */
export function extractFinishReason(response: unknown): string | null {
  const r = response as { choices?: Array<{ finish_reason?: unknown }> } | null;
  const fr = r?.choices?.[0]?.finish_reason;
  return typeof fr === 'string' ? fr : null;
}

export function normalizeProbeType(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^A-Z0-9_]/g, '');
}

/** Exact match, else a unique prefix match (flagged by the caller). */
export function matchProbeType(raw: string, allowed: string[]): { type: string; exact: boolean } | null {
  const norm = normalizeProbeType(raw);
  if (!norm) return null;
  const upper = allowed.map((t) => t.toUpperCase());
  const exactIdx = upper.indexOf(norm);
  if (exactIdx >= 0) return { type: allowed[exactIdx]!, exact: true };
  const prefixed = upper.map((t, i) => (t.startsWith(norm) || norm.startsWith(t) ? i : -1)).filter((i) => i >= 0);
  if (prefixed.length === 1) return { type: allowed[prefixed[0]!]!, exact: false };
  return null;
}

export function countWords(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

function stripDecoration(content: string): string {
  return content
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .replace(/```[a-zA-Z]*\s*([\s\S]*?)```/g, '$1')
    .trim();
}

/**
 * Models copy the prompt's curly-quoted example ({“probe_type”: …}) — but a
 * participant's own words inside a string may legitimately contain curly
 * quotes. So this is only a FALLBACK when the raw text fails to parse.
 */
function straightenQuotes(s: string): string {
  return s.replace(/[“”„″]/g, '"').replace(/[‘’‚′]/g, "'");
}

/** First balanced {...} block, respecting strings. Null if none closes. */
export function firstJsonObject(s: string): string | null {
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

export function parseModelOutput(content: string | null, opts: ParseOptions): ParseResult {
  if (content == null) return { kind: 'parse_error', reason: 'empty response' };
  const text = stripDecoration(content);
  if (!text) return { kind: 'parse_error', reason: 'empty after stripping' };

  const tokenRe = new RegExp(`(^|[^A-Z0-9_])${escapeRe(opts.moveOnToken)}([^A-Z0-9_]|$)`, 'i');

  // Try the text as written first, then with curly quotes straightened.
  let obj: Record<string, unknown> | null = null;
  let sawJson = false;
  for (const candidate of [text, straightenQuotes(text)]) {
    const json = firstJsonObject(candidate);
    if (!json) continue;
    sawJson = true;
    try {
      const parsed: unknown = JSON.parse(json);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        obj = parsed as Record<string, unknown>;
        break;
      }
    } catch {
      /* try the next candidate */
    }
  }

  if (!obj) {
    if (!sawJson) {
      if (tokenRe.test(text) && text.length <= 80) return { kind: 'move_on' };
      return { kind: 'parse_error', reason: 'neither move-on token nor JSON object' };
    }
    // A move-on token beside malformed JSON is still a clear move-on.
    if (tokenRe.test(text)) return { kind: 'move_on' };
    return { kind: 'parse_error', reason: 'malformed JSON' };
  }

  // Some models wrap the decision: {"decision": "MOVE_ON"} or {"question": "MOVE_ON"}.
  const values = Object.values(obj).filter((v): v is string => typeof v === 'string');
  if (values.some((v) => normalizeProbeType(v) === normalizeProbeType(opts.moveOnToken))) return { kind: 'move_on' };

  const question = typeof obj.question === 'string' ? obj.question.trim().replace(/^["']|["']$/g, '') : '';
  if (!question) return { kind: 'parse_error', reason: 'missing question' };
  if (question.length > 400) return { kind: 'parse_error', reason: 'question too long (>400 chars)' };

  const rawType = typeof obj.probe_type === 'string' ? obj.probe_type : typeof obj.type === 'string' ? obj.type : '';
  const match = matchProbeType(rawType, opts.probeTypes);
  if (!match) return { kind: 'parse_error', reason: `unknown probe_type "${rawType}"` };

  const flags: Record<string, unknown> = {};
  if (!match.exact) flags.normalized_probe_type = rawType;
  const words = countWords(question);
  if (words > opts.maxQuestionWords) flags.overlength = words;

  const trigger = typeof obj.trigger === 'string' ? obj.trigger.trim().slice(0, 500) : '';
  return { kind: 'probe', probeType: match.type, trigger, question, flags };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
