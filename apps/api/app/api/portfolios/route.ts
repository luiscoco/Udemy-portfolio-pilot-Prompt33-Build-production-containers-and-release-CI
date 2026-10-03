import { requireAuthorization } from '../../../lib/authorization';
import { boundedJsonBody, portfolioResponse } from '../../../lib/portfolio-http';
export const runtime = 'nodejs';
export function GET(request: Request) {
  return portfolioResponse(request, async () => ({ portfolios: await (await requireAuthorization(request)).portfolios.list() }));
}
export function POST(request: Request) {
  return portfolioResponse(request, async () => {
    const { portfolios } = await requireAuthorization(request);
    return { portfolio: await portfolios.create(await boundedJsonBody(request)) };
  }, 201);
}
