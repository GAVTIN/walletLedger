import type { LlmClient } from './client';

type Req = { system: string; user: string; maxTokens?: number };

/**
 * Test double: no network, no API key. It records every call so tests can
 * assert exactly what was sent to the model, and answers via a plain function.
 */
export class MockLlm implements LlmClient {
  readonly calls: Req[] = [];
  constructor(private readonly handler: (req: Req) => string | Promise<string>) {}
  async complete(req: Req): Promise<string> {
    this.calls.push(req);
    return this.handler(req);
  }
}

/** "Fixed JSON" mock: exact question text -> exact JSON string the model would return. */
export function fixedResponses(table: Record<string, string>, fallback = '{"type":0}') {
  return (req: Req): string => table[req.user] ?? fallback;
}

// ---------------------------------------------------------------------------
// Demo-mode brain (LLM_PROVIDER=mock). A few regexes standing in for a model so
// `docker compose up` is demoable without an API key. Same prompts, same JSON.
// ---------------------------------------------------------------------------
const iso = (d: Date) => d.toISOString().slice(0, 10);

export function heuristicHandler(req: Req): string {
  if (req.system.startsWith('TASK: explain_flag')) return heuristicExplain(req.user);
  return heuristicIntent(req);
}

function heuristicIntent(req: Req): string {
  const q = req.user;
  const today = new Date(`${/Today is (\d{4}-\d{2}-\d{2})/.exec(req.system)?.[1] ?? iso(new Date())}T00:00:00Z`);
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  let from = new Date(Date.UTC(y, m, 1));
  let to = today;
  const lower = q.toLowerCase();
  const days = /last (\d{1,3}) days/.exec(lower);
  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const named = new RegExp(`\\b(${MONTHS.join('|')})\\b(?:\\s+(\\d{4}))?`).exec(lower);
  if (named) {
    // "in August" / "August 2026": that whole calendar month (no year given => the latest such month not in the future)
    const mi = MONTHS.indexOf(named[1]);
    const yr = named[2] ? Number(named[2]) : mi > m ? y - 1 : y;
    from = new Date(Date.UTC(yr, mi, 1));
    to = new Date(Date.UTC(yr, mi + 1, 0));
  } else if (lower.includes('last month')) {
    from = new Date(Date.UTC(y, m - 1, 1));
    to = new Date(Date.UTC(y, m, 0));
  } else if (lower.includes('last year')) {
    from = new Date(Date.UTC(y - 1, 0, 1));
    to = new Date(Date.UTC(y - 1, 11, 31));
  } else if (lower.includes('this year')) {
    from = new Date(Date.UTC(y, 0, 1));
  } else if (days) {
    from = new Date(today.getTime() - Number(days[1]) * 86_400_000);
  } else if (lower.includes('this month')) {
    /* defaults */
  }
  const range = { from: iso(from), to: iso(to) };

  if (/\b(largest|biggest|highest)\b/.test(lower)) return JSON.stringify({ type: 3, ...range });
  if (/\b(how many|number of|count)\b/.test(lower)) return JSON.stringify({ type: 4, ...range });
  if (/\b(receive|received|receiving|got|earned|came in)\b/.test(lower)) return JSON.stringify({ type: 2, ...range });
  if (/\b(sent|send|paid|pay)\b/.test(lower)) {
    const who = /\bto ([A-Z][\p{L}]+)/u.exec(q)?.[1];
    return JSON.stringify(who ? { type: 1, counterparty: who, ...range } : { type: 1, ...range });
  }
  return '{"type":0}';
}

function heuristicExplain(user: string): string {
  let rules: string[] = [];
  try {
    rules = (JSON.parse(user) as { fired_rules: { code: string }[] }).fired_rules.map((r) => r.code);
  } catch {
    /* fall through */
  }
  const label = rules.length >= 3 ? 'likely_fraud' : rules.length === 1 && rules[0] === 'NEW_RECIPIENT_HIGH' ? 'likely_ok' : 'review';
  return JSON.stringify({
    label,
    explanation: `This transfer triggered ${rules.join(', ') || 'a risk rule'}. A reviewer should compare it with the wallet's recent activity before deciding.`,
  });
}
