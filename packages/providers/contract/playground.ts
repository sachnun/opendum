import { oc } from "@orpc/contract";
import { z } from "zod";

import { emptyInputSchema } from "./common.js";

const playgroundEndpointSchema = z.enum(["chat_completions", "messages", "responses"]);
const authInput = z.object({ endpoint: playgroundEndpointSchema }).strict();

export const playgroundContract = {
  options: oc.input(emptyInputSchema),
  auth: oc.input(authInput),
};

export type PlaygroundEndpoint = z.infer<typeof playgroundEndpointSchema>;
export type PlaygroundAuthInput = z.infer<typeof authInput>;
