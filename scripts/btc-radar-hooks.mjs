const RADAR_MODULES = new Set([
  "btc-radar.mjs", "btc-radar-html.mjs", "btc-radar-model.mjs",
  "btc-radar-risk.mjs", "btc-radar-sources.mjs"
]);
let source;
let release;

export function initialize(data) {
  ({ source, release } = data);
}

export async function resolve(specifier, context, nextResolve) {
  const relative = specifier.startsWith("./") || specifier.startsWith("../");
  if (!relative && !specifier.startsWith("file:")) return nextResolve(specifier, context);
  const fromRelease = relative && context.parentURL?.startsWith(release);
  const target = new URL(specifier, fromRelease ? source : context.parentURL);
  if (target.href.startsWith(source) && RADAR_MODULES.has(target.href.slice(source.length))) {
    return nextResolve(new URL(target.href.slice(source.length), release).href, context);
  }
  // All shared modules still come from the Bot checkout, not a copied release.
  return nextResolve(fromRelease ? target.href : specifier, context);
}
