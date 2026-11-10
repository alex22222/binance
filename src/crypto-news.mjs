import { createHash } from "node:crypto";

const DAY = 86_400_000;
const MAX_BYTES = 2_000_000;
const WINDOW_DAYS = 7;
export const CRYPTO_NEWS_SOURCES = Object.freeze([
  { id: "coindesk", label: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss", kind: "news", hosts: ["www.coindesk.com", "coindesk.com"] },
  { id: "cointelegraph", label: "Cointelegraph", url: "https://cointelegraph.com/rss", kind: "news", hosts: ["cointelegraph.com", "www.cointelegraph.com"] },
  { id: "decrypt", label: "Decrypt", url: "https://decrypt.co/feed", kind: "news", hosts: ["decrypt.co"] },
  { id: "okx-announcements", label: "OKX 官方公告", url: "https://www.okx.com/zh-hans/help/section/announcements-latest-announcements", kind: "announcement", hosts: ["www.okx.com"] }
]);
const IDENTITIES = new Set(["HYPE", "LIT", "CHIP", "GRASS", "NFT", "PUMP", "DOT", "NEAR", "CRV", "UNI", "LTC", "BTC", "PAXG", "OKB", "ZAMA", "SPCX", "ANTHROPIC"]);
const clock = now => {
  const value = new Date(typeof now === "function" ? now() : now);
  if (!Number.isFinite(value.getTime())) throw new Error("新闻采集时间无效");
  return value;
};
const validTime = (value, now) => typeof value === "string" && Number.isFinite(Date.parse(value)) && Date.parse(value) <= now + 300_000;
const withinWindow = (value, now) => validTime(value, now) && now - Date.parse(value) <= WINDOW_DAYS * DAY;
const plain = text => String(text || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]*>/g, "")
  .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|rsquo|lsquo|rdquo|ldquo|ndash|mdash|hellip);/gi, (all, entity) => {
    if (entity[0] === "#") {
      const point = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : "";
    }
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", ndash: "–", mdash: "—", hellip: "…" }[entity.toLowerCase()] || all;
  }).replace(/<[^>]*>/g, "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();

function sourceDefinition(source) {
  const known = CRYPTO_NEWS_SOURCES.find(row => row.id === source?.id && row.url === source?.url);
  if (!known) throw new Error("新闻来源不在允许列表中");
  return known;
}

function canonicalLink(value, source) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || !source.hosts.includes(url.hostname)) return null;
    if (source.kind === "announcement" && !/^\/zh-hans\/help\/[a-z0-9][a-z0-9-]{0,240}$/.test(url.pathname)) return null;
    if (url.pathname === "/") return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) if (/^utm_|^(?:fbclid|gclid|mc_cid|mc_eid)$/i.test(key)) url.searchParams.delete(key);
    return url.href;
  } catch { return null; }
}

function headline({ title, url, publishedAt, fetchedAt }, source, now) {
  const cleanTitle = plain(title).slice(0, 240), link = canonicalLink(url, source);
  if (!cleanTitle || !link || !withinWindow(publishedAt, now) || !validTime(fetchedAt, now)) return null;
  return { id: createHash("sha256").update(link).digest("hex").slice(0, 24), sourceId: source.id, kind: source.kind,
    title: cleanTitle, url: link, publishedAt: new Date(publishedAt).toISOString(), fetchedAt: new Date(fetchedAt).toISOString() };
}

function deduplicate(items, limit = 100) {
  const seen = new Set();
  return items.filter(item => item && !seen.has(item.url) && seen.add(item.url)).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).slice(0, limit);
}

function assertRss(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_BYTES || /<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error("RSS 文档无效或超过大小限制");
  const tags = /<(?:!--[\s\S]*?--|!\[CDATA\[[\s\S]*?\]\]|\?[\s\S]*?\?|\/?[A-Za-z_][A-Za-z0-9_.:-]*(?:[^<>"']|"[^"]*"|'[^']*')*)>/g;
  const stack = [];
  let cursor = 0, roots = 0, channel = false;
  for (const match of text.matchAll(tags)) {
    const between = text.slice(cursor, match.index);
    if (between.includes("<") || (!stack.length && between.replace(/^\uFEFF/, "").trim())) throw new Error("RSS XML 结构无效");
    cursor = match.index + match[0].length;
    const tag = match[0];
    if (/^<!--|^<\?|^<!\[CDATA\[/.test(tag)) continue;
    const name = tag.match(/^<\/?([A-Za-z_][A-Za-z0-9_.:-]*)/)?.[1];
    if (tag.startsWith("</")) {
      if (!new RegExp(`^<\\/${name}\\s*>$`).test(tag) || stack.pop() !== name) throw new Error("RSS XML 标签不匹配");
    } else {
      if (!stack.length) { roots += 1; if (name !== "rss" || roots !== 1) throw new Error("不是 RSS 新闻源"); }
      if (name === "channel" && stack.at(-1) === "rss") channel = true;
      if (!tag.endsWith("/>")) stack.push(name);
    }
  }
  if (stack.length || text.slice(cursor).trim() || roots !== 1 || !channel) throw new Error("RSS XML 结构不完整");
}

export function parseNewsFeed(text, { source = CRYPTO_NEWS_SOURCES[0], now = () => new Date(), fetchedAt } = {}) {
  const definition = sourceDefinition(source), current = clock(now);
  if (definition.kind !== "news") throw new Error("来源不是 RSS 新闻源");
  assertRss(text);
  const retrieved = fetchedAt || current.toISOString();
  const items = [];
  let count = 0;
  for (const [, block] of text.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item\s*>/g)) {
    if (++count > 500) throw new Error("RSS 条目过多");
    const field = tag => plain(block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, "i"))?.[1]);
    const published = Date.parse(field("pubDate"));
    items.push(headline({ title: field("title"), url: field("link"), publishedAt: Number.isFinite(published) ? new Date(published).toISOString() : "", fetchedAt: retrieved }, definition, current.getTime()));
  }
  return deduplicate(items);
}

export function parseOkxAnnouncements(text, { source = CRYPTO_NEWS_SOURCES.find(row => row.kind === "announcement"), now = () => new Date(), fetchedAt } = {}) {
  const definition = sourceDefinition(source), current = clock(now);
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_BYTES) throw new Error("OKX 公告页面超过大小限制");
  const states = [...text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)].filter(([, attrs]) => /\bid\s*=\s*["']appState["']/i.test(attrs) && /\btype\s*=\s*["']application\/json["']/i.test(attrs));
  if (states.length !== 1) throw new Error("OKX 公告页面缺少有效 SSR 数据");
  const context = JSON.parse(states[0][2]).appContext;
  const articles = context?.initialProps?.sectionData?.articleList;
  if (context?.isSSRSuccess !== true || context?.serverSideProps?.isTransientCmsFailure !== false || context?.serverSideProps?.page !== 1 || context?.serverSideProps?.cfLocale !== "zh-CN"
    || articles?.pageNum !== 1 || !Array.isArray(articles.list) || articles.list.length > 100) throw new Error("OKX 公告 SSR 状态无效或读取未完成");
  return deduplicate(articles.list.map(row => {
    if (typeof row?.slug !== "string" || !/^[a-z0-9][a-z0-9-]{0,240}$/.test(row.slug) || !Number.isFinite(row.publishTime)) return null;
    return headline({ title: row.title, url: `https://www.okx.com/zh-hans/help/${row.slug}`, publishedAt: new Date(row.publishTime).toISOString(), fetchedAt: fetchedAt || current.toISOString() }, definition, current.getTime());
  }));
}

const baseOf = instrument => typeof instrument === "string" ? instrument.split("-")[0] : instrument?.base || instrument?.instId?.split("-")[0];
const near = (title, name, context) => {
  for (const match of title.matchAll(name)) {
    const left = title.slice(Math.max(0, match.index - 60), match.index).split(/[;!?。；！？]/).at(-1);
    const right = title.slice(match.index + match[0].length, match.index + match[0].length + 60).split(/[;!?。；！？]/)[0];
    if (context.test(`${left}${match[0]}${right}`)) return match[0];
  }
  return null;
};

export function matchNewsToInstrument(item, instrument) {
  const base = baseOf(instrument), title = plain(item?.title);
  if (!IDENTITIES.has(base) || !title) return [];
  if (item.kind === "announcement" && item.sourceId === "okx-announcements") {
    const official = title.match(new RegExp(`(?:^|[^A-Za-z0-9])(${base}(?:(?:-|/)?USDT(?:-SWAP)?)?)(?=$|[^A-Za-z0-9])`));
    if (official) return [official[1]];
  }
  const direct = {
    HYPE: /\bHyperliquid\b/i, CHIP: /\bUSD\.AI\b|\bUSDai\b/i, NFT: /\bAINFT\b/i, PUMP: /\bPump\.fun\b|\bPumpfun\b/i,
    DOT: /\bPolkadot\b/i, NEAR: /\bNEAR Protocol\b|\$NEAR\b/i, CRV: /\bCurve (?:DAO|Finance)\b|\$CRV\b/i,
    UNI: /\bUniswap\b/i, LTC: /\bLitecoin\b/i, BTC: /\bBitcoin\b|\bBTC\b/i, PAXG: /\bPAX Gold\b|\bPaxos\s?Gold\b|\bPAXG\b/i,
    OKB: /\bOKB\b/, SPCX: /\bSpaceX\b/i, ANTHROPIC: /\bAnthropic\b|\bClaude\b/
  }[base];
  const match = direct ? title.match(direct)?.[0] : base === "LIT" && !/\bLitentry\b/i.test(title)
    ? near(title, /\bLighter\b/g, /\bDEX\b|exchange|protocol|perpetual|airdrop|\$LIT\b|\bLIT\b|交易所|协议|永续|空投/i)
    : base === "GRASS" ? near(title, /\bGrass\b/g, /crypto|DePIN|network|token|airdrop|\$GRASS\b|GRASS[\/-]USDT|网络|代币|空投|链上/i)
      : base === "ZAMA" ? near(title, /\bZama\b/g, /crypto|FHE|protocol|blockchain|encryption|全同态|加密|协议|区块链/i) : null;
  return match ? [match] : [];
}

async function fetchSource(source, fetchImpl) {
  const response = await fetchImpl(source.url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: { "User-Agent": "Mozilla/5.0", Accept: source.kind === "announcement" ? "text/html" : "application/rss+xml,application/xml,text/xml", "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" } });
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(`HTTP ${response.status}`); }
  if (Number(response.headers.get("content-length")) > MAX_BYTES || !response.body) { await response.body?.cancel().catch(() => {}); throw new Error("来源响应为空或超过大小限制"); }
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error("来源响应超过大小限制");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { await reader.cancel().catch(() => {}); }
}

function cachedSource(previous, source, now) {
  const prior = Array.isArray(previous?.sources) ? previous.sources.find(row => row?.id === source.id && row.url === source.url) : null;
  if (!prior || !["OK", "CACHED"].includes(prior.status) || !Array.isArray(prior.items) || prior.items.length > 100 || !validTime(prior.fetchedAt, now) || !validTime(prior.lastSuccessAt, now)
    || now - Date.parse(prior.lastSuccessAt) > WINDOW_DAYS * DAY) return null;
  const items = prior.items.map(row => row?.sourceId === source.id && row.kind === source.kind ? headline(row, source, now) : null);
  if (items.some((row, index) => row === null && withinWindow(prior.items[index]?.publishedAt, now))) return null;
  return { fetchedAt: prior.fetchedAt, lastSuccessAt: prior.lastSuccessAt, items: deduplicate(items) };
}

export async function collectCryptoNews({ instruments, previous = null, fetchImpl = fetch, now = () => new Date() }) {
  if (!Array.isArray(instruments) || instruments.length > 100) throw new Error("新闻观察名单无效");
  const generatedAt = clock(now).toISOString();
  const sources = await Promise.all(CRYPTO_NEWS_SOURCES.map(async source => {
    const lastAttemptAt = clock(now).toISOString();
    const coverage = source.kind === "announcement" ? "OKX 全球简体中文最新公告首页的部分标题；七天仅为发布时间过滤，不是完整七天检索。" : `${source.label} 最新 RSS 部分标题；七天仅为发布时间过滤，不是完整七天检索。`;
    try {
      const text = await fetchSource(source, fetchImpl), retrieved = clock(now);
      const options = { source, now: retrieved, fetchedAt: retrieved.toISOString() };
      const items = source.kind === "announcement" ? parseOkxAnnouncements(text, options) : parseNewsFeed(text, options);
      return { id: source.id, label: source.label, url: source.url, kind: source.kind, status: "OK", lastAttemptAt, fetchedAt: retrieved.toISOString(), lastSuccessAt: retrieved.toISOString(), error: null, coverage, items };
    } catch (error) {
      const cached = cachedSource(previous, source, clock(now).getTime());
      return { id: source.id, label: source.label, url: source.url, kind: source.kind, status: cached ? "CACHED" : "FAILED", lastAttemptAt,
        fetchedAt: cached?.fetchedAt ?? null, lastSuccessAt: cached?.lastSuccessAt ?? null, error: error.name === "TimeoutError" || error.name === "AbortError" ? "来源读取超时" : "来源读取或解析失败", coverage, items: cached?.items || [] };
    }
  }));
  const allFailed = sources.every(row => row.status === "FAILED"), incomplete = sources.some(row => row.status !== "OK");
  const pool = deduplicate(sources.flatMap(row => row.items), 400);
  const seen = new Set();
  const byBase = instruments.flatMap(instrument => {
    const base = baseOf(instrument);
    if (typeof base !== "string" || seen.has(base)) return [];
    seen.add(base);
    if (!IDENTITIES.has(base)) return [{ base, name: String(instrument.name || base).slice(0, 100), status: "UNSUPPORTED", items: [] }];
    const items = pool.flatMap(item => { const matchedTerms = matchNewsToInstrument(item, instrument); return matchedTerms.length ? [{ ...item, matchedTerms }] : []; }).slice(0, 5);
    return [{ base, name: String(instrument.name || base).slice(0, 100), status: allFailed ? "UNAVAILABLE" : incomplete ? "PARTIAL" : items.length ? "OK" : "NO_MATCHES", items }];
  });
  return { schemaVersion: 1, generatedAt, windowDays: WINDOW_DAYS, status: allFailed ? "FAILED" : incomplete ? "PARTIAL" : "OK", sources, byBase,
    announcements: sources.find(row => row.kind === "announcement")?.items.slice(0, 10) || [], errors: sources.filter(row => row.status !== "OK").map(row => `${row.label}：${row.status === "CACHED" ? "读取失败，沿用原时间的缓存标题" : "读取失败，未取得有效标题"}`) };
}
