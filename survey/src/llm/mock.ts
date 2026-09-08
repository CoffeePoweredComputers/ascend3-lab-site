/**
 * Offline stand-in for the ARC service (LLM_PROVIDER=mock; refused in production).
 *
 * Deterministic so tests and manual walkthroughs are repeatable: it moves on
 * when the latest answer is under five words or after the second follow-up,
 * otherwise asks a probe whose type cycles through the survey's taxonomy.
 * The reply is shaped like an OpenAI chat completion so the same parser runs.
 */
import type { CompletionRequest, CompletionResult, LlmClient } from './index.js';

export class MockClient implements LlmClient {
  readonly name = 'mock';

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const user = req.messages.find((m) => m.role === 'user')?.content ?? '';
    const answers = [...user.matchAll(/^A: (.*)$/gm)].map((m) => m[1] ?? '');
    const last = answers[answers.length - 1] ?? '';
    const askedMatch = /Follow-ups asked so far on this question: (\d+) of (\d+)/.exec(user);
    const asked = askedMatch ? Number(askedMatch[1]) : 0;
    const types = req.hints?.probeTypes ?? ['DESCRIPTIVE_EXTERNAL'];
    const token = req.hints?.moveOnToken ?? 'MOVE_ON';

    const words = last.trim().split(/\s+/).filter(Boolean).length;
    let content: string;
    if (words < 5 || asked >= 2) {
      content = token;
    } else {
      const type = types[asked % types.length]!;
      const question =
        asked === 0
          ? 'Can you walk me through one specific time that happened?'
          : 'What do you recall thinking at that point?';
      content = JSON.stringify({ probe_type: type, trigger: `mock: ${words}-word answer, follow-up ${asked + 1}`, question });
    }
    const body = {
      id: 'mock',
      object: 'chat.completion',
      model: req.model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    };
    return { body, latencyMs: 1 };
  }
}
