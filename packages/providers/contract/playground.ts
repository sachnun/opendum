import { oc } from "@orpc/contract";
import { z } from "zod";

import { emptyInputSchema } from "./common.js";

const playgroundEndpointSchema = z.enum(["chat_completions", "messages", "responses"]);
const playgroundAuthInputSchema = z.object({ endpoint: playgroundEndpointSchema }).strict();

export const playgroundContract = {
  options: oc.input(emptyInputSchema),
  auth: oc.input(playgroundAuthInputSchema),
};

export type PlaygroundEndpoint = z.infer<typeof playgroundEndpointSchema>;
export type PlaygroundAuthInput = z.infer<typeof playgroundAuthInputSchema>;
