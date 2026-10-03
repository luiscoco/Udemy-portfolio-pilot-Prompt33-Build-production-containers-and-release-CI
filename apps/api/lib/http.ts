import { correlationIdSchema, errorEnvelopeSchema, REQUEST_ID_HEADER, type ErrorEnvelope } from '@portfolio-pilot/contracts';

const requestIds = new WeakMap<Request, string>();
/** One ID per request: the caller's validated X-Request-ID, else a generated UUID (stable for this Request). */
export function getRequestId(request: Request): string {
  const known = requestIds.get(request);
  if (known) return known;
  const supplied = correlationIdSchema.safeParse(request.headers.get(REQUEST_ID_HEADER));
  const id = supplied.success ? supplied.data : crypto.randomUUID();
  requestIds.set(request, id);
  return id;
}

export function errorResponse(code: ErrorEnvelope['error']['code'], message: string, requestId: string, status: number): Response {
  const body = errorEnvelopeSchema.parse({ error: { code, message, requestId } });
  return Response.json(body, { status, headers: { [REQUEST_ID_HEADER]: requestId } });
}
