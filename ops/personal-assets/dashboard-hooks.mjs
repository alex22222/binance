const MODULES = [
  "personal-assets-core.mjs", "personal-assets.mjs", "personal-assets-html.mjs",
  "personal-assets-client.mjs", "personal-assets-routes.mjs", "site-shell.mjs",
  "personal-assets-sync.mjs", "personal-assets-okx.mjs", "personal-assets-futu.mjs", "personal-assets-fx.mjs", "personal-assets-polymarket.mjs", "personal-assets-wallets.mjs", "personal-assets-ai.mjs"
];

let source;
let release;
let mappings;

export function initialize(data) {
  ({ source, release } = data);
  mappings = new Map(MODULES.map((name) => [new URL(name, source).href, new URL(name, release).href]));
}

export async function resolve(specifier, context, nextResolve) {
  const relative = specifier.startsWith("./") || specifier.startsWith("../");
  if ((!relative && !specifier.startsWith("file:")) || !context.parentURL) return nextResolve(specifier, context);
  const fromRelease = relative && context.parentURL.startsWith(release);
  const target = new URL(specifier, fromRelease ? source : context.parentURL).href;
  if (mappings.has(target)) return nextResolve(mappings.get(target), context);
  // Dependencies outside the asset/shell modules retain the Bot checkout.
  const resolved = await nextResolve(fromRelease ? target : specifier, context);
  // A prior release hook may resolve shared imports back into the original src.
  return mappings.has(resolved.url) ? nextResolve(mappings.get(resolved.url), context) : resolved;
}
