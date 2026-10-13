import { defineHandler } from "nitro";
import { unknownEndpoint } from "../../../src/routes/errors.js";

export default defineHandler(() => unknownEndpoint());
