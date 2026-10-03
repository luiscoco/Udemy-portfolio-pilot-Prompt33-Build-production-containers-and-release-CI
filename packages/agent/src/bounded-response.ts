/** Bound decompressed response bytes before decoding/parsing (not just Content-Length). */
export async function boundedResponseText(response: Response, limit: number): Promise<string> {
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new Error('Response limit'); }
  const reader = response.body?.getReader(); if (!reader) throw new Error('Empty response');
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength; if (bytes > limit) throw new Error('Response limit');
      chunks.push(next.value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel(); reader.releaseLock(); }
}
