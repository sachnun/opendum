const V1_PREFIX = "/v1";

export default defineEventHandler((event) => {
  const { pathname } = getRequestURL(event);
  if (pathname !== V1_PREFIX && !pathname.startsWith(`${V1_PREFIX}/`)) return;

  const config = useRuntimeConfig(event);
  const proxyUrl = String(config.proxyUrl || config.public.proxyUrl || "").trim().replace(/\/+$/, "");
  const target = proxyUrl ? ` Use ${proxyUrl}${pathname} instead.` : "";

  setResponseStatus(event, 404);
  return {
    error: {
      message: `This host does not serve the API.${target}`,
      type: "invalid_request_error",
      param: null,
      code: null,
    },
  };
});
