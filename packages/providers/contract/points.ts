import { oc } from "@orpc/contract";

import { emptyInputSchema } from "./common.js";

export const pointsContract = {
  get: oc.input(emptyInputSchema),
};
