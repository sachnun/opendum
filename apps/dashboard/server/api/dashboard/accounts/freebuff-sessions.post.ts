import { freebuffSessionBatchInputSchema, getFreebuffSessions } from "../../../services/freebuff-session";
import { parseBody, requireReadableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => getFreebuffSessions(await requireReadableUserId(event), await parseBody(event, freebuffSessionBatchInputSchema)));
