import { requireAuthorization } from '../../../../lib/authorization';
import { boundedJsonBody, portfolioResponse } from '../../../../lib/portfolio-http';
export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
export function PATCH(request: Request, context: Context) {
  return portfolioResponse(request, async () => { const { watchlist } = await requireAuthorization(request); return { entry: await watchlist.edit((await context.params).id, await boundedJsonBody(request)) }; });
}
export function DELETE(request: Request, context: Context) {
  return portfolioResponse(request, async () => (await requireAuthorization(request)).watchlist.remove((await context.params).id));
}
