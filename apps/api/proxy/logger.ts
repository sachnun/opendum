import { Layer, Logger, References } from "effect";

export const JsonLoggerLayer = Logger.layer([Logger.consoleJson]);

export const LoggerLayer = Layer.mergeAll(
  JsonLoggerLayer,
  Layer.succeed(References.MinimumLogLevel, "Info" as const)
);
