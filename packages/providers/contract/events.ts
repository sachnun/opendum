import { eventIterator, oc } from "@orpc/contract";
import { z } from "zod";

export const liveTopicSchema = z.enum(["points", "accounts", "models"]);

export const pointsUpdateSchema = z.object({
  type: z.literal("update"),
  topic: z.literal("points"),
  at: z.string(),
  data: z.object({ balance: z.number() }),
});

export const tickSchema = z.object({
  type: z.literal("tick"),
  topic: z.enum(["accounts", "models"]),
  at: z.string(),
});

export const pingSchema = z.object({
  type: z.literal("ping"),
  at: z.string(),
});

export const serverEventSchema = z.discriminatedUnion("type", [
  pointsUpdateSchema,
  tickSchema,
  pingSchema,
]);

export const subscribeInputSchema = z.object({
  topics: z.array(liveTopicSchema),
});

export const eventsContract = {
  subscribe: oc.input(subscribeInputSchema).output(eventIterator(serverEventSchema, z.void())),
};

export type LiveTopic = z.infer<typeof liveTopicSchema>;
export type SubscribeInput = z.infer<typeof subscribeInputSchema>;
export type ServerEvent = z.infer<typeof serverEventSchema>;
