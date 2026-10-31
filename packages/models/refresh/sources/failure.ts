import { Cause, Option } from "effect";
import { failureMessage } from "@opendum/models/errors";

const messageOf = (value: unknown): string => {
  if (value instanceof Error) return value.message;
  if (value !== null && typeof value === "object" && "message" in value) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return failureMessage(value);
};

export const causeMessage = (cause: Cause.Cause<unknown>): string =>
  Option.match(Cause.findErrorOption(cause), {
    onNone: () => messageOf(Cause.squash(cause)),
    onSome: messageOf,
  });
