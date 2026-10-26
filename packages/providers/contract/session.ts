import { oc } from "@orpc/contract";

import { emptyInputSchema } from "@opendum/providers/contract/common";

export const sessionContract = {
  get: oc.input(emptyInputSchema),
};
