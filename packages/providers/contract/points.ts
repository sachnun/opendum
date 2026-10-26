import { oc } from "@orpc/contract";

import { emptyInputSchema } from "@opendum/providers/contract/common";

export const pointsContract = {
  get: oc.input(emptyInputSchema),
};
