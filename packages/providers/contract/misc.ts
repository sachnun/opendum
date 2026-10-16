import { oc } from "@orpc/contract";
import { z } from "zod";

const emptyInputSchema = z.object({});
const sharingInputSchema = z.object({ enabled: z.boolean() });
const playgroundEndpointSchema = z.enum(["chat_completions", "messages", "responses"]);
const playgroundAuthInputSchema = z.object({ endpoint: playgroundEndpointSchema }).strict();
const MAX_MAINTAINER_SEARCH_LIMIT = 30;
const userSearchInputSchema = z.object({
  q: z.string().trim().max(120).optional(),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(MAX_MAINTAINER_SEARCH_LIMIT).default(12),
});

export const meContract = {
  get: oc.input(emptyInputSchema),
};

export const pointsContract = {
  status: oc.input(emptyInputSchema),
};

export const sharingContract = {
  get: oc.input(emptyInputSchema),
  set: oc.input(sharingInputSchema),
};

export const playgroundContract = {
  options: oc.input(emptyInputSchema),
  auth: oc.input(playgroundAuthInputSchema),
};

export const maintainerContract = {
  users: {
    search: oc.input(userSearchInputSchema),
  },
};

export type SharingInput = z.infer<typeof sharingInputSchema>;
export type PlaygroundEndpoint = z.infer<typeof playgroundEndpointSchema>;
export type PlaygroundAuthInput = z.infer<typeof playgroundAuthInputSchema>;
export type MaintainerUserSearchInput = z.infer<typeof userSearchInputSchema>;
