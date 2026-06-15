-- CreateIndex
CREATE INDEX "idx_assistant_query_log_trace_id" ON "assistant_query_logs"("trace_id");

-- RenameIndex
ALTER INDEX "uq_assistant_response_feedback_trace_user" RENAME TO "assistant_response_feedback_trace_id_user_id_key";
