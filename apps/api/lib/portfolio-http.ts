import { PortfolioError } from '@portfolio-pilot/db';
import { accessResponse } from './authorization';
import { errorResponse, getRequestId } from './http';
export { boundedJsonBody } from './request-body';
import { inSpan, metric } from '@portfolio-pilot/observability';
import { REQUEST_ID_HEADER } from '@portfolio-pilot/contracts';
/**
 * JSON route wrapper: one `api.request` server span per request (route templates are not known here,
 * so the span carries the method and request ID, never the path with its IDs), and the request ID on
 * every response so a browser report, a log line and a trace can be joined.
 */
export async function portfolioResponse(request: Request, operation: () => Promise<unknown>, status = 200) {
  const requestId = getRequestId(request);
  const response = await inSpan('api.request', { 'pp.request.id': requestId, 'http.request.method': request.method }, async span => {
    const result = await portfolioResult(request, operation, status);
    span.setAttribute('http.response.status_code', result.status);
    if (result.status >= 500) { span.setStatus({ code: 2 }); metric.error('api', 'internal_error'); }
    return result;
  }, { kind: 'server' });
  response.headers.set(REQUEST_ID_HEADER, requestId);
  return response;
}
async function portfolioResult(request: Request, operation: () => Promise<unknown>, status: number) {
  try { return Response.json(await operation(), { status, headers: { 'Cache-Control': 'no-store' } }); }
  catch (error) {
    let response: Response;
    if (error instanceof PortfolioError) response = errorResponse(error.code ?? (error.status === 400 ? 'BAD_REQUEST' : error.status === 404 ? 'NOT_FOUND' : error.status === 409 ? 'CONFLICT' : error.status === 429 ? 'BUDGET_EXHAUSTED' : 'INTERNAL_ERROR'), error.message, getRequestId(request), error.status);
    else if (error instanceof SyntaxError || (error as { name?: string }).name === 'ZodError') response = errorResponse('BAD_REQUEST', 'Invalid request.', getRequestId(request), 400);
    else if ((error as { code?: string }).code === 'P2002') response = errorResponse('CONFLICT', 'An entry with that name or security already exists.', getRequestId(request), 409);
    else response = accessResponse(request, error);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  }
}
