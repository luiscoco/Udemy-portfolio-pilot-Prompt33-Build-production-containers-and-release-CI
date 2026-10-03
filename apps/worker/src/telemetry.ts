import { activeTraceparent, createLogger, metric, startSpan, type Logger, type Span } from '@portfolio-pilot/observability';
import type { AgentRunEvent } from '@portfolio-pilot/agent';


/** Worker structured logger; the service name carries the role (ingestion, outbox, agent). */
let logger: Logger | null = null;
export function workerLog(): Logger { return logger ??= createLogger(`portfolio-pilot-worker-${process.env.WORKER_ROLE || 'ingestion'}`); }

type ToolEvent = Extract<AgentRunEvent, { type: 'tool.status' }>;
/**
 * Turns the adapter's sanitized tool progress (the same events the browser sees) into one span per
 * application tool call, parented to the agent.run span active when the run started. Works for the
 * live SDK and the mock alike; arguments and results are never attached.
 */
export class ToolSpans {
  private readonly parent = activeTraceparent();
  private readonly open = new Map<string, { span: Span; tool: string }>();
  observe(event: AgentRunEvent) {
    if (event.type !== 'tool.status') return;
    const { toolCallId, tool, status } = event as ToolEvent;
    if (status === 'started' || status === 'running') {
      if (!this.open.has(toolCallId)) this.open.set(toolCallId, { span: startSpan('agent.tool', { 'pp.tool_call.id': toolCallId, 'pp.tool': tool }, { parent: this.parent }).span, tool });
      return;
    }
    const entry = this.open.get(toolCallId) ?? { span: startSpan('agent.tool', { 'pp.tool_call.id': toolCallId, 'pp.tool': tool }, { parent: this.parent }).span, tool };
    this.open.delete(toolCallId);
    entry.span.setAttribute('pp.status', status);
    if (status === 'failed') entry.span.setStatus({ code: 2 });
    entry.span.end();
    metric.toolCall(tool, status);
  }
  /** A run that stops mid-call still ends its spans, marked abandoned. */
  close() {
    for (const { span, tool } of this.open.values()) { span.setAttribute('pp.status', 'abandoned'); span.end(); metric.toolCall(tool, 'abandoned'); }
    this.open.clear();
  }
}
