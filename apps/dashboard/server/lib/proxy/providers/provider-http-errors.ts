const CLOUDFLARE_CHALLENGE_MARKERS = [
  "cf-mitigated",
  "window._cf_chl_opt",
  "/cdn-cgi/challenge-platform/",
  "Enable JavaScript and cookies to continue",
  "Just a moment",
];

export function isLikelyCloudflareChallenge(
  response: Response,
  body: string
): boolean {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const cfMitigated = response.headers.get("cf-mitigated")?.toLowerCase() ?? "";

  return (
    cfMitigated === "challenge" ||
    contentType.includes("text/html") ||
    CLOUDFLARE_CHALLENGE_MARKERS.some((marker) => body.includes(marker))
  );
}

export function formatProviderHttpError(
  providerLabel: string,
  response: Response,
  body: string,
  options: { endpointLabel?: string; bodyLimit?: number } = {}
): string {
  const endpointLabel = options.endpointLabel ?? "endpoint";
  const cfRay = response.headers.get("cf-ray");
  const cfRaySuffix = cfRay ? ` (cf-ray: ${cfRay})` : "";

  if (isLikelyCloudflareChallenge(response, body)) {
    return `${providerLabel} ${endpointLabel} returned HTTP ${response.status} from Cloudflare${cfRaySuffix}`;
  }

  const bodyLimit = options.bodyLimit ?? 300;
  return `${providerLabel} ${endpointLabel} returned HTTP ${response.status}${
    body ? ` ${body.slice(0, bodyLimit)}` : ""
  }`;
}

export const formatQuotaHttpError = formatProviderHttpError;
