import { z } from 'zod';

/**
 * Server → client WebSocket frames, as a discriminated union on `type`.
 * The frontend parses each frame with `safeParse` and ignores anything that
 * doesn't match, so an unknown/malformed frame can never throw in `onmessage`.
 */

const withMessage = { sessionId: z.string().optional(), message: z.string().optional() };

export const WsConnectedSchema = z.object({ type: z.literal('connected'), ...withMessage });
export const WsSubscribedSchema = z.object({ type: z.literal('subscribed'), sessionId: z.string().optional() });
export const WsProcessingStartedSchema = z.object({
  type: z.literal('processing_started'),
  parentSessionId: z.string().optional(),
  ...withMessage,
});
export const WsRecordsParsedSchema = z.object({
  type: z.literal('records_parsed'),
  sessionId: z.string().optional(),
  companyRecordsCount: z.number(),
  facebookRecordsCount: z.number(),
});
export const WsSavedToDatabaseSchema = z.object({ type: z.literal('saved_to_database'), ...withMessage });
export const WsSendingToWebhookSchema = z.object({ type: z.literal('sending_to_webhook'), ...withMessage });
export const WsWebhookSuccessSchema = z.object({ type: z.literal('webhook_success'), ...withMessage });
export const WsWaitingForResultsSchema = z.object({ type: z.literal('waiting_for_results'), ...withMessage });
export const WsComparisonStartingSchema = z.object({ type: z.literal('comparison_starting'), ...withMessage });
export const WsComparisonTriggeredSchema = z.object({ type: z.literal('comparison_triggered'), ...withMessage });
export const WsComparisonFailedSchema = z.object({ type: z.literal('comparison_failed'), ...withMessage });
export const WsProcessingFailedSchema = z.object({ type: z.literal('processing_failed'), ...withMessage });
export const WsBatchReceivedSchema = z.object({
  type: z.literal('batch_received'),
  sessionId: z.string().optional(),
  batchNumber: z.number(),
  totalBatches: z.number(),
  recordsCount: z.number(),
  isComplete: z.boolean().optional(),
  progress: z.number(),
});
export const WsComparisonCompleteSchema = z.object({
  type: z.literal('comparison_complete'),
  sessionId: z.string().optional(),
  totalRecords: z.number(),
});

export const WsServerMessageSchema = z.discriminatedUnion('type', [
  WsConnectedSchema,
  WsSubscribedSchema,
  WsProcessingStartedSchema,
  WsRecordsParsedSchema,
  WsSavedToDatabaseSchema,
  WsSendingToWebhookSchema,
  WsWebhookSuccessSchema,
  WsWaitingForResultsSchema,
  WsComparisonStartingSchema,
  WsComparisonTriggeredSchema,
  WsComparisonFailedSchema,
  WsProcessingFailedSchema,
  WsBatchReceivedSchema,
  WsComparisonCompleteSchema,
]);
export type WsServerMessage = z.infer<typeof WsServerMessageSchema>;
export type WsServerMessageType = WsServerMessage['type'];

/** Client → server frame (the socket also derives sessionId from the query string). */
export const WsClientMessageSchema = z.object({
  type: z.literal('subscribe'),
  sessionId: z.string(),
});
export type WsClientMessage = z.infer<typeof WsClientMessageSchema>;

/** Terminal frames the progress UI should react to. */
export const WS_TERMINAL_TYPES = ['comparison_complete', 'comparison_failed', 'processing_failed'] as const;
