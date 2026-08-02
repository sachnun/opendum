import { transformResponsesSSEToChat, transformChatSSEToResponses } from "./responses_transform.js";

export async function* transformResponsesToChatGen(body: ReadableStream<Uint8Array> | null, model: string): AsyncGenerator<string> {
  yield* transformResponsesSSEToChat(body, model);
}

export async function* transformChatToResponsesGen(body: ReadableStream<Uint8Array> | null, model: string): AsyncGenerator<string> {
  yield* transformChatSSEToResponses(body, model);
}
