import { requireAuthorization } from '../../../../lib/authorization';
import { boundedJsonBody, portfolioResponse } from '../../../../lib/portfolio-http';
export const runtime = 'nodejs';
export function GET(request: Request) { return portfolioResponse(request, async () => ({ rules: await (await requireAuthorization(request)).alerts.rules() })); }
export function POST(request: Request) { return portfolioResponse(request, async () => ({ rule: await (await requireAuthorization(request)).alerts.create(await boundedJsonBody(request)) }), 201); }
