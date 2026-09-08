/**
 * Build the chat messages for one probe decision.
 *
 * By protocol the model sees ONLY the current main question, the exchanges on
 * that question, and how many follow-ups it has already asked. Nothing about
 * the participant, the wave, other starters, or prior sessions is ever
 * included — this function is the single place that constructs model input,
 * so that guarantee is checkable by reading it.
 */
import type { Starter, SurveyConfig } from '../config/schema.js';
import type { TurnRow } from './types.js';

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

export function buildMessages(
  cfg: SurveyConfig,
  starter: Starter,
  /** Turn rows for THIS starter only (kinds starter/probe/answer), in seq order. */
  starterTurns: TurnRow[],
  probesAsked: number,
  maxProbes: number,
): ChatMessage[] {
  const lines: string[] = [];
  lines.push(`Main question: ${starter.text}`);
  lines.push('');
  lines.push('Conversation on this question so far:');
  for (const t of starterTurns) {
    if (t.kind === 'starter') lines.push(`Q (main): ${t.text ?? starter.text}`);
    else if (t.kind === 'probe') lines.push(`Q (follow-up ${t.probeIndex}, ${t.probeType ?? 'UNLABELLED'}): ${t.text ?? ''}`);
    else if (t.kind === 'answer') lines.push(`A: ${t.text ?? ''}`);
  }
  lines.push('');
  lines.push(`Follow-ups asked so far on this question: ${probesAsked} of ${maxProbes}.`);
  lines.push('');
  lines.push(
    `Reply with exactly ${cfg.probing.moveOnToken}, or with a single JSON object ` +
      `{"probe_type": "...", "trigger": "...", "question": "..."} and nothing else.`,
  );
  return [
    { role: 'system', content: cfg.probing.systemPrompt },
    { role: 'user', content: lines.join('\n') },
  ];
}
