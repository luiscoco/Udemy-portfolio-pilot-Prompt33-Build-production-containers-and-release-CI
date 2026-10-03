import { PortfolioError } from '@portfolio-pilot/db';
/** Bound bytes before JSON parsing, including chunked requests; limit slow body reads. */
export async function boundedJsonBody(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new PortfolioError(400, 'Expected JSON.');
  const chunks: Uint8Array[] = []; let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => {
    reject(new PortfolioError(400, 'Request body timeout.')); void reader.cancel().catch(() => {});
  }, 10000); });
  try {
    if (Number(request.headers.get('content-length') ?? 0) > 10000) throw new PortfolioError(400, 'Request too large.');
    for (;;) {
      const part = await Promise.race([reader.read(), deadline]); if (part.done) break;
      size += part.value.byteLength;
      if (size > 10000) throw new PortfolioError(400, 'Request too large.');
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { clearTimeout(timer); void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
