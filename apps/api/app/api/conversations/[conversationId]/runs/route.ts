import { requireAuthorization } from '../../../../../lib/authorization';
import { portfolioResponse } from '../../../../../lib/portfolio-http';
import { chatBody, startChatRun } from '../../../../../lib/chat';
import { getRequestId } from '../../../../../lib/http';
import { actorRef, annotate, createLogger, inSpan } from '@portfolio-pilot/observability';
const log = createLogger('portfolio-pilot-api');
export const runtime = 'nodejs';
/** Creates a streamed run and returns 202 with its ID and a pre-run SSE replay cursor. */
export function POST(request: Request, context: { params: Promise<{ conversationId: string }> }) {
  return portfolioResponse(request, async () => {
    // Submissions have their own per-user window; admission also caps active runs per user.
    const auth = await requireAuthorization(request, { rateLimit: 'agent_submit' });
    const actor = actorRef(auth.user.id), requestId = getRequestId(request);
    // The queued job row stores this span's context; the agent worker continues the same trace.
    return inSpan('chat.run.create', { 'pp.request.id': requestId, 'pp.actor': actor }, async span => {
      const { run, userMessage, replayCursor } = await startChatRun({ ownerId: auth.user.id, conversationId: (await context.params).conversationId, body: await chatBody(request), chat: auth.chat });
      annotate({ 'pp.run.id': run.id, 'pp.job.id': run.id, 'pp.kind': run.kind }, span);
      log.info('chat.run.queued', { requestId, actor, runId: run.id, jobId: run.id, kind: run.kind });
      return { run, userMessage, replayCursor };
    });
  }, 202);
}
