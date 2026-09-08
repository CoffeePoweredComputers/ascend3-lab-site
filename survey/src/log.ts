/**
 * Structured logs to stdout (journald picks them up under the systemd unit).
 *
 * Policy: identifiers and outcomes only. No participant text, no question
 * text, no PIDs beside a session id. Callers pass small field maps; anything
 * that could be free text is truncated at the call site before it gets here.
 */
import type { Logger } from './engine/session.js';

type Level = 'info' | 'warn' | 'error';

function emit(level: Level, event: string, fields?: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...(fields ?? {}) });
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const log: Logger = {
  info: (event, fields) => emit('info', event, fields),
  warn: (event, fields) => emit('warn', event, fields),
  error: (event, fields) => emit('error', event, fields),
};
