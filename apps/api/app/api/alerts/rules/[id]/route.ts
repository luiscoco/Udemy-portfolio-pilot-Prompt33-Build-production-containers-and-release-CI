import { requireAuthorization } from '../../../../../lib/authorization';
import { boundedJsonBody, portfolioResponse } from '../../../../../lib/portfolio-http';
export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
export function PUT(request: Request, context: Context) { return portfolioResponse(request, async () => ({ rule: await (await requireAuthorization(request)).alerts.edit((await context.params).id, await boundedJsonBody(request)) })); }
export function DELETE(request: Request, context: Context) { return portfolioResponse(request, async () => (await requireAuthorization(request)).alerts.remove((await context.params).id)); }
