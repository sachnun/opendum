import { oc } from "@orpc/contract";

import { emptyInputSchema } from "./common.js";

export const sessionContract = {
  get: oc.input(emptyInputSchema),
};
