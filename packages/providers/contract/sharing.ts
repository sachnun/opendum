import { oc } from "@orpc/contract";
import { z } from "zod";

import { emptyInputSchema } from "@opendum/providers/contract/common";

export const sharingInputSchema = z.object({ enabled: z.boolean() });

export const sharingContract = {
  get: oc.input(emptyInputSchema),
  update: oc.input(sharingInputSchema),
};

export type SharingInput = z.infer<typeof sharingInputSchema>;
