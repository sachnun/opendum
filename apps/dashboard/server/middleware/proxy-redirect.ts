const V1_PREFIX = "/v1";
const TEMPORARY_REDIRECT = 307;

export default defineEventHandler((event) => {
  const { pathname, search } = getRequestURL(event);
  if (pathname !== V1_PREFIX && !pathname.startsWith(`${V1_PREFIX}/`)) return;

  const config = useRuntimeConfig(event);
  const proxyUrl = String(config.proxyUrl || config.public.proxyUrl || "").trim().replace(/\/+$/, "");
  if (!proxyUrl) throw createError({ statusCode: 503, statusMessage: "Proxy URL is not configured." });

  return sendRedirect(event, new URL(`${pathname}${search}`, `${proxyUrl}/`).toString(), TEMPORARY_REDIRECT);
});
