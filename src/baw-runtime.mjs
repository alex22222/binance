export function buildBawEnvironment({ environment = process.env, instanceId }) {
  if (!instanceId) {
    throw new Error("Binance Agentic Wallet instance ID is missing");
  }
  const result = {
    ...environment,
    BINANCE_INSTANCE_ID: instanceId
  };
  const proxyConfigured = [
    environment.HTTP_PROXY,
    environment.HTTPS_PROXY,
    environment.ALL_PROXY,
    environment.http_proxy,
    environment.https_proxy,
    environment.all_proxy
  ].some((value) => typeof value === "string" && value.trim());
  if (proxyConfigured && !environment.NODE_OPTIONS?.includes("--use-env-proxy")) {
    result.NODE_OPTIONS = [environment.NODE_OPTIONS, "--use-env-proxy"].filter(Boolean).join(" ");
  }
  return result;
}
