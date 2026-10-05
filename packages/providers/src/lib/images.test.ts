import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  convertImageURLsToBase64,
  convertResponsesInputImageURLsToBase64,
  type ImageFetch,
} from "#providers/lib/images.ts";

function pngResponse(): Response {
  return new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
    status: 200,
    headers: { "content-type": "image/png" },
  });
}

function capture(response: Response): { fetch: ImageFetch; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetch: async (url) => {
      urls.push(url);
      return response;
    },
  };
}

describe("convertImageURLsToBase64", () => {
  it("returns messages unchanged without external images", async () => {
    const messages = [{ role: "user", content: "hi" }];
    assert.equal(await convertImageURLsToBase64(async () => pngResponse(), messages), messages);
  });

  it("inlines a safe external image", async () => {
    const { fetch, urls } = capture(pngResponse());
    const messages = [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://8.8.8.8/a.png" } }] }];
    const result = (await convertImageURLsToBase64(fetch, messages)) as Array<Record<string, unknown>>;
    const url = ((result[0]!.content as Array<Record<string, unknown>>)[0]!.image_url as Record<string, string>).url;
    assert.match(url!, /^data:image\/png;base64,/);
    assert.deepEqual(urls, ["https://8.8.8.8/a.png"]);
    assert.equal(
      ((messages[0]!.content as Array<Record<string, unknown>>)[0]!.image_url as Record<string, string>).url,
      "https://8.8.8.8/a.png"
    );
  });

  it("leaves private, failing and non-image URLs untouched", async () => {
    const message = (url: string) => [{ role: "user", content: [{ type: "image_url", image_url: { url } }] }];
    const privateUrl = await convertImageURLsToBase64(async () => pngResponse(), message("http://127.0.0.1/a.png"));
    assert.equal(
      (((privateUrl[0] as Record<string, unknown>).content as Array<Record<string, unknown>>)[0]!.image_url as Record<string, string>).url,
      "http://127.0.0.1/a.png"
    );

    const notFound = await convertImageURLsToBase64(capture(new Response(null, { status: 404 })).fetch, message("https://8.8.8.8/a.png"));
    assert.equal(
      (((notFound[0] as Record<string, unknown>).content as Array<Record<string, unknown>>)[0]!.image_url as Record<string, string>).url,
      "https://8.8.8.8/a.png"
    );

    const html = await convertImageURLsToBase64(
      capture(new Response("x", { status: 200, headers: { "content-type": "text/html" } })).fetch,
      message("https://8.8.8.8/a.png")
    );
    assert.equal(
      (((html[0] as Record<string, unknown>).content as Array<Record<string, unknown>>)[0]!.image_url as Record<string, string>).url,
      "https://8.8.8.8/a.png"
    );
  });

  it("keeps non-image content parts", async () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hello" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
    ];
    const result = (await convertImageURLsToBase64(async () => pngResponse(), messages)) as Array<Record<string, unknown>>;
    assert.equal((result[0]!.content as unknown[]).length, 2);
  });
});

describe("convertResponsesInputImageURLsToBase64", () => {
  it("returns input unchanged without external images", async () => {
    const input = [{ content: [{ type: "input_text", text: "x" }] }];
    assert.equal(await convertResponsesInputImageURLsToBase64(async () => pngResponse(), input), input);
  });

  it("inlines input_image entries", async () => {
    const input = [{ content: [{ type: "input_image", image_url: "https://8.8.8.8/a.png" }] }];
    const result = (await convertResponsesInputImageURLsToBase64(async () => pngResponse(), input)) as Array<Record<string, unknown>>;
    assert.match((result[0]!.content as Array<Record<string, string>>)[0]!.image_url!, /^data:image\/png;base64,/);
  });
});
