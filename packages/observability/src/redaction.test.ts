import { expect, it } from 'vitest';
import { logMetadata } from './redaction.js';
it('redacts nested secrets, payloads, credential URLs and raw errors with bounded depth', () => {
  const lines: string[] = [];
  logMetadata({ runId: 'run-1', nested: { ANTHROPIC_API_KEY: 'fixture-key', DATABASE_URL: 'postgres://alice:fixture-password@localhost/db', authorization: 'Bearer fixture-token', prompt: 'private holdings' }, error: new Error('fixture-secret'), note: 'Bearer fixture-token https://collector.example.com/?token=fixture-secret' }, s => lines.push(s));
  expect(lines[0]).toContain('run-1');
  for (const value of ['fixture-key', 'fixture-password', 'fixture-token', 'fixture-secret', 'private holdings']) expect(lines[0]).not.toContain(value);
  const circular: any = {}; circular.self = circular; expect(() => logMetadata(circular, () => {})).not.toThrow();
});
