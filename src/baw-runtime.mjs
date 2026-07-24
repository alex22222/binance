export function buildBawEnvironment({ environment = process.env, instanceId }) {
  if (!instanceId) {
    throw new Error("Binance Agentic Wallet instance ID is missing");
  }
  const nodeOptions = environment.NODE_OPTIONS?.includes("--use-env-proxy")
    ? environment.NODE_OPTIONS
    : [environment.NODE_OPTIONS, "--use-env-proxy"].filter(Boolean).join(" ");
  return {
    ...environment,
    HTTP_PROXY: "http://127.0.0.1:7890",
    HTTPS_PROXY: "http://127.0.0.1:7890",
    ALL_PROXY: "socks5://127.0.0.1:7890",
    NO_PROXY: "127.0.0.1",
    BINANCE_INSTANCE_ID: instanceId,
    NODE_OPTIONS: nodeOptions
  };
}
