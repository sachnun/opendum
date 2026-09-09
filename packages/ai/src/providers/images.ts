export async function convertImageURLsToBase64(messages: any[]): Promise<any[]> {
  if (!Array.isArray(messages)) return messages;

  const out: any[] = [];

  for (const raw of messages) {
    if (!raw || typeof raw !== "object") {
      out.push(raw);
      continue;
    }

    if (!Array.isArray(raw.content)) {
      out.push(raw);
      continue;
    }

    const newParts: any[] = [];
    for (const part of raw.content) {
      if (part && typeof part === "object" && part.type === "image_url") {
        const url = part.image_url?.url;
        if (typeof url === "string" && (url.startsWith("http://") || url.startsWith("https://"))) {
          try {
            const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
            if (res.ok) {
              const contentType = res.headers.get("content-type")?.split(";")[0] || "image/png";
              const buffer = await res.arrayBuffer();
              const base64 = Buffer.from(buffer).toString("base64");
              newParts.push({
                type: "image_url",
                image_url: {
                  url: `data:${contentType};base64,${base64}`,
                },
              });
              continue;
            }
          } catch {
            // fallback keep original
          }
        }
      }
      newParts.push(part);
    }

    out.push({ ...raw, content: newParts });
  }

  return out;
}
