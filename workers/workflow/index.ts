// Durable execution lives in apps/api/src/index.ts via Queue consumer (queueBatch)
// + runFlowLocal with per-step retry. No Workflow class needed: the queue's
// max_retries gives redelivery, and each step retries once internally.
// (An earlier wrangler.jsonc declared a FLOW_RUN Workflow binding — removed
// because nothing referenced it; re-add only if step counts outgrow queues.)
