-- Add unique constraint on trace_id for the relation to AssistantResponseFeedback
CREATE UNIQUE INDEX IF NOT EXISTS "assistant_query_logs_trace_id_key" ON "assistant_query_logs"("trace_id");
