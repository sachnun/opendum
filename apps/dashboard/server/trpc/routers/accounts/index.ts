import { router } from "../../init";
import { byProviderAccountsProcedure, createAccountProcedure, listAccountsProcedure } from "./basic";

export const accountsRouter = router({
  list: listAccountsProcedure,
  byProvider: byProviderAccountsProcedure,
  create: createAccountProcedure,
});
