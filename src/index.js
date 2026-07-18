// The wdl.md worker: routing, the page shell, and the files crawlers and agents
// read. content.gen.js ships finished HTML and finished markdown per page and
// language, so nothing here parses markdown.

import { PAGES } from "./content.gen.js";
import { escape } from "./escape.js";

// ---- the site ----

const ORG = "https://github.com/wdl-dev";
const SITE_URL = "https://wdl.md/";
const { origin: SITE_ORIGIN, hostname: SITE_HOST } = new URL(SITE_URL);
const DESCRIPTION =
  "wdl.md — the documentation for WDL, a self-hosted multi-tenant Workers platform: " +
  "architecture, module contracts, and the CLI guide, in English and Chinese.";
// The WDL gateway owns /healthz on custom domains, so use a worker-specific path.
const HEALTH_PATH = "/_worker-healthz";

// Section display order; PAGES insertion order rules within a section.
const SECTIONS = ["Platform", "Platform modules", "Operations", "CLI", "Libraries", "Apps"];

// A zh page must not narrate itself in English. Section names double as PAGES
// keys, so they are translated here rather than renamed.
const SECTION_LABEL = {
  zh: {
    "Platform": "平台",
    "Platform modules": "平台模块",
    "Operations": "运维",
    "CLI": "CLI",
    "Libraries": "库",
    "Apps": "应用",
  },
};
const UI = {
  en: {
    nav: "Documentation",
    contents: "Contents",
    edit: "Edit this page on GitHub ↗",
    foot: "repositories · this page is itself a WDL Worker.",
    footLead: "Rendered from the",
  },
  zh: {
    nav: "文档导航",
    contents: "目录",
    edit: "在 GitHub 上编辑本页 ↗",
    foot: "仓库渲染而来 · 本页自身就是一个 WDL Worker。",
    footLead: "内容由",
  },
};
const t = (lang) => UI[lang === "zh" ? "zh" : "en"];
const sectionLabel = (section, lang) => SECTION_LABEL[lang]?.[section] ?? section;

// CLI-printable short links: stable entry points that survive doc reshuffles.
const REDIRECTS = {
  "/guide": "/cli/guide",
  "/init": "/cli/guide#scaffolding-a-new-worker",
  "/deploy": "/cli/deploy",
  "/d1": "/cli/d1",
  "/r2": "/cli/r2",
  "/kv": "/cli/kv",
  "/secrets": "/cli/secrets",
  "/architecture": "/platform/architecture",
  "/security": "/platform/security",
};

const BY_SLUG = new Map(PAGES.map((p) => [p.slug, p]));

// Empty sections are dropped once, here: module pages come from a readdir, so a
// section can legitimately be empty and every consumer would have to guard.
const navSections = SECTIONS.map((section) => ({
  section,
  pages: PAGES.filter((p) => p.section === section),
})).filter(({ pages }) => pages.length > 0);

// Where a page lives on this site; the /zh prefix rule is stated once.
const pageUrl = (slug, lang) => `${SITE_ORIGIN}${lang === "zh" ? "/zh" : ""}/${slug}`;

// The language variant actually served: a zh request falls back to English
// when the source repo has no translation.
const variant = (page, lang) => (lang === "zh" ? page.zh ?? page.en : page.en);

// Splice `insert` in ahead of any fragment the URL already carries — used for
// both the preserved query string and the .md suffix.
function beforeFragment(url, insert) {
  if (!insert) return url;
  const cut = url.indexOf("#");
  return cut === -1 ? url + insert : url.slice(0, cut) + insert + url.slice(cut);
}

// ---- HTML rendering ----

// env.ASSETS.url() exists only on WDL, so these are the local fallback. Token
// estimates use them unconditionally — real URLs would change only the count.
const ASSET_FILES = { cssUrl: "styles.css", faviconUrl: "favicon.svg", logoUrl: "logo.png", ogUrl: "og.png" };
const LOCAL_ASSETS = Object.fromEntries(Object.entries(ASSET_FILES).map(([k, f]) => [k, `/${f}`]));

// Constant per binding, so resolved once and cached against it — two envs never
// share a result.
const assetPromises = new WeakMap();
function assetUrls(env) {
  const assets = env?.ASSETS;
  if (!assets?.url) return LOCAL_ASSETS;
  let pending = assetPromises.get(assets);
  if (!pending) {
    // The calls sit inside the async body so that a binding throwing
    // synchronously rejects the promise rather than escaping as a 500.
    pending = (async () => {
      const urls = await Promise.all(Object.values(ASSET_FILES).map((f) => assets.url(f)));
      return Object.fromEntries(Object.keys(ASSET_FILES).map((k, i) => [k, urls[i]]));
    })()
      // Degrades the styling, not the document; not kept, so the next request
      // retries.
      .catch(() => { assetPromises.delete(assets); return LOCAL_ASSETS; });
    assetPromises.set(assets, pending);
  }
  return pending;
}

function sidebar(currentSlug, lang) {
  const items = navSections
    .map(({ section, pages }) => {
      const links = pages
        .map((p) => {
          // A page without a translation is linked in English, not through a
          // /zh URL that would only redirect.
          const to = p.zh ? lang : "en";
          const cur = p.slug === currentSlug ? ' aria-current="page"' : "";
          const href = pageUrl(p.slug, to).slice(SITE_ORIGIN.length);
          return `<li><a href="${escape(href)}"${cur}>${escape(variant(p, to).title)}</a></li>`;
        })
        .join("\n          ");
      return `<div class="nav-group">
        <div class="nav-label">${escape(sectionLabel(section, lang))}</div>
        <ul>
          ${links}
        </ul>
      </div>`;
    })
    .join("\n      ");
  // tabindex allows the mobile drawer to take focus when it opens.
  return `<nav class="side" id="sidenav" tabindex="-1" aria-label="${escape(t(lang).nav)}">
      ${items}
    </nav>`;
}

function shell({ title, docTitle, description, body, cssUrl, faviconUrl, logoUrl, ogUrl, currentSlug, lang, langToggle, withSidebar = true }) {
  // Its text is in the language it switches TO, so it carries its own lang and
  // hreflang — otherwise a screen reader reads 中文 with English rules.
  const zhLink = langToggle
    ? `<a class="lang" href="${escape(langToggle.href)}" lang="${langToggle.lang}" hreflang="${langToggle.lang}">${escape(langToggle.label)}</a>`
    : "";
  const canonical = currentSlug ? pageUrl(currentSlug, lang) : SITE_URL;
  // langToggle is present exactly when the page has both language variants.
  const alternates = currentSlug && langToggle
    ? `<link rel="alternate" hreflang="en" href="${SITE_ORIGIN}/${escape(currentSlug)}">
<link rel="alternate" hreflang="zh" href="${SITE_ORIGIN}/zh/${escape(currentSlug)}">
<link rel="alternate" hreflang="x-default" href="${SITE_ORIGIN}/${escape(currentSlug)}">
`
    : "";
  const graph = [
    { "@type": "Organization", name: "WDL", url: "https://wdl.dev/", logo: logoUrl, sameAs: [ORG] },
    { "@type": "WebSite", name: "wdl.md — WDL documentation", url: SITE_URL, description: DESCRIPTION },
  ];
  if (currentSlug) {
    graph.push({
      "@type": "TechArticle",
      headline: docTitle,
      url: canonical,
      inLanguage: lang === "zh" ? "zh" : "en",
      isPartOf: { "@type": "WebSite", url: SITE_URL },
    });
  }
  const jsonLd = JSON.stringify({ "@context": "https://schema.org", "@graph": graph })
    .replace(/</g, "\\u003c");
  return `<!DOCTYPE html>
<html lang="${lang === "zh" ? "zh" : "en"}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<meta name="description" content="${escape(description)}">
<link rel="canonical" href="${escape(canonical)}">
${alternates}<meta property="og:type" content="website">
<meta property="og:site_name" content="wdl.md">
<meta property="og:url" content="${escape(canonical)}">
<meta property="og:title" content="${escape(title)}">
<meta property="og:description" content="${escape(description)}">
<meta property="og:image" content="${escape(ogUrl)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="wdl.md — The WDL docs, on one domain.">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">${jsonLd}</script>
<meta name="color-scheme" content="light dark">
<script>try{const t=localStorage.getItem("theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t;if(localStorage.getItem("nav")==="hidden")document.documentElement.dataset.nav="hidden"}catch(e){}</script>
<link rel="icon" href="${escape(faviconUrl)}">
<link rel="stylesheet" href="${escape(cssUrl)}">
<noscript><style>
/* Both toggles need the script, so without it they go — at every width. The
   drawer cannot open either, so on compact screens the nav stacks above the
   article where it is at least reachable. */
.frame > .nav-toggle, .theme-toggle { display: none; }
@media (max-width: 860px) {
  .side { display: block; position: static; width: auto; max-height: none;
    margin: 0; padding: 20px 0 20px 10px; border-right: 0;
    border-bottom: 1px solid var(--line); }
}
</style></noscript>
</head>
<body>
  <header class="top">
    <div class="top-inner${withSidebar ? "" : " narrow"}">
      <a class="brand" href="/">wdl<span class="tld">.md</span></a>
      <span class="top-links">
        ${zhLink}
        <a href="https://wdl.dev" target="_blank" rel="noopener">wdl.dev</a>
        <a href="${ORG}" target="_blank" rel="noopener">GitHub</a>
        <button class="theme-toggle" type="button"
          aria-label="${lang === "zh" ? "切换亮 / 暗主题" : "Toggle light / dark theme"}">
          <svg class="t-light" width="17" height="17" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="9" cy="9" r="3.5"/><path d="M9 1.5v2M9 14.5v2M1.5 9h2M14.5 9h2M3.7 3.7l1.4 1.4M12.9 12.9l1.4 1.4M14.3 3.7l-1.4 1.4M5.1 12.9l-1.4 1.4"/></svg>
          <svg class="t-dark" width="17" height="17" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M15.5 10.5A6.5 6.5 0 1 1 7.5 2.5a5.5 5.5 0 0 0 8 8z"/></svg>
        </button>
      </span>
    </div>
  </header>
  <div class="frame${withSidebar ? "" : " solo"}">
    ${withSidebar ? `<button class="nav-toggle" type="button" aria-controls="sidenav"
      aria-label="${lang === "zh" ? "显示/隐藏导航" : "Show or hide navigation"}">
      <svg width="14" height="14" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.5 4.5 6 9l4.5 4.5"/></svg>
      <span class="nav-text">${escape(t(lang).contents)}</span>
    </button>
    ${sidebar(currentSlug, lang)}
    <div class="scrim" aria-hidden="true"></div>` : ""}
    <main class="prose">
${body}
      <footer class="doc-foot">
        <p>${escape(t(lang).footLead)} <a href="${ORG}" target="_blank" rel="noopener">wdl-dev</a> ${escape(t(lang).foot)}</p>
        <span class="colophon">Sean Consulting OÜ · Apache-2.0</span>
      </footer>
    </main>
  </div>
<script>
(() => {
  const root = document.documentElement;
  // Keep in step with the 860px breakpoint in styles.css.
  const compact = () => matchMedia("(max-width: 860px)").matches;

  const nav = document.querySelector(".nav-toggle");
  if (nav) {
    const sidenav = document.getElementById("sidenav");
    const main = document.querySelector(".prose");
    const isOpen = () => root.dataset.drawer === "open";
    const sync = () => nav.setAttribute("aria-expanded",
      compact() ? String(isOpen()) : String(root.dataset.nav !== "hidden"));
    // Opening takes the article out of reach — inert, so neither keyboard nor
    // assistive tech lands behind the scrim — and moves focus in, returning it
    // on close. The bar stays usable: it is not what the drawer covers.
    const setDrawer = (open) => {
      const wasInside = sidenav.contains(document.activeElement);
      if (open) root.dataset.drawer = "open"; else delete root.dataset.drawer;
      main.inert = open;
      sync();
      if (open) sidenav.focus();
      else if (wasInside) nav.focus();
    };
    const closeDrawer = () => setDrawer(false);
    nav.addEventListener("click", () => {
      if (compact()) {
        // Compact screens use a transient drawer; it resets on navigation.
        setDrawer(!isOpen());
      } else {
        // The bar's max-width slides via CSS; sidebar and content snap.
        if (root.dataset.nav === "hidden") delete root.dataset.nav; else root.dataset.nav = "hidden";
        try { localStorage.setItem("nav", root.dataset.nav || "visible"); } catch (e) {}
        sync();
      }
    });
    // Growing past the breakpoint closes it too: the drawer has no layout to
    // belong to there and its inert article must not stay locked. The label is
    // restated either way — aria-expanded means "drawer open" below the
    // breakpoint and "sidebar shown" above it.
    document.querySelector(".scrim")?.addEventListener("click", closeDrawer);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && isOpen()) closeDrawer(); });
    addEventListener("resize", () => { if (isOpen() && !compact()) closeDrawer(); else sync(); });
    sync();
  }

  // Two-state theme flip; until first use the site follows the system.
  document.querySelector(".theme-toggle").addEventListener("click", () => {
    const dark = root.dataset.theme
      ? root.dataset.theme === "dark"
      : matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark";
    try { localStorage.setItem("theme", root.dataset.theme); } catch (e) {}
  });
})();
</script>
</body>
</html>`;
}

export function renderDocPage(page, lang, assets) {
  const { html, title, path, summary } = variant(page, lang);
  const editUrl = `${ORG}/${page.repo}/blob/main/${path}`;
  const langToggle = page.zh
    ? lang === "zh"
      ? { href: `/${page.slug}`, label: "EN", lang: "en" }
      : { href: `/zh/${page.slug}`, label: "中文", lang: "zh" }
    : null;
  const body = `      <article>
${html}
      </article>
      <p class="edit-row"><a href="${escape(editUrl)}" target="_blank" rel="noopener">${escape(t(lang).edit)}</a></p>`;
  return shell({
    title: `${title} · wdl.md`,
    docTitle: title,
    // Each page describes itself; one site-wide blurb would collapse every
    // search snippet and social card into the same text.
    description: summary || DESCRIPTION,
    body,
    ...assets,
    currentSlug: page.slug,
    lang,
    langToggle,
  });
}

export function renderHomePage(assets) {
  const cards = navSections
    .map(({ section, pages }) => {
      const first = pages[0];
      const rest = pages.length > 1 ? ` · ${pages.length} pages` : "";
      return `<a class="card" href="/${escape(first.slug)}">
        <span class="card-head">${escape(section)}</span>
        <span class="card-sub">${escape(first.en.title)}${escape(rest)}</span>
      </a>`;
    })
    .join("\n      ");
  const body = `      <div class="hero">
        <p class="eyebrow">Documentation</p>
        <h1>The WDL docs, on one domain.</h1>
        <p class="sub">Everything the <a href="https://wdl.dev" target="_blank" rel="noopener">wdl-dev</a>
          repositories know — platform architecture, module contracts, and the full CLI guide —
          aggregated and rendered from their markdown. English and 中文.</p>
        <div class="inset" role="img" aria-label="curl wdl.md/llms.txt for the machine-readable index, any page with a .md suffix for its markdown source, or /zh/ for the Chinese variant">
          <div class="line"><span class="prompt">$ </span>curl https://wdl.md/llms.txt</div>
          <div class="line"><span class="prompt">$ </span>curl https://wdl.md/cli/guide.md</div>
          <div class="line"><span class="prompt">$ </span>curl https://wdl.md/zh/cli/guide.md</div>
        </div>
      </div>
      <div class="cards">
      ${cards}
      </div>`;
  return shell({
    title: "wdl.md — WDL documentation",
    description: DESCRIPTION,
    body,
    ...assets,
    currentSlug: null,
    lang: "en",
    langToggle: null,
    // The cards are the home page's navigation; a full sidebar next to this
    // little content leaves the layout left-heavy.
    withSidebar: false,
  });
}

// ---- markdown for agents ----
// Cloudflare's contract, implemented in the worker: an Accept preference for
// text/markdown, or a `.md` suffix, returns markdown instead of HTML.
// developers.cloudflare.com/fundamentals/reference/markdown-for-agents/

// Naming text/markdown asks for it — except with q=0, which RFC 9110 defines
// as a refusal. Anything finer is negotiation this site does not need.
const wantsMarkdown = (request) => {
  const named = /(^|,)\s*text\/markdown\s*(;[^,]*)?(,|$)/i.exec(request.headers.get("accept") ?? "");
  if (!named) return false;
  return !/;\s*q=0(\.0+)?\s*(;|$)/i.test(named[2] ?? "");
};

// One token per ideograph or fullwidth punctuation, four characters per token
// otherwise — a plain length/4 undercounts Chinese pages several-fold.
const CJK_CHARS = /[\u2e80-\u9fff\uff00-\uffef]/gu;
const estimateTokens = (s) => {
  const cjk = (s.match(CJK_CHARS) ?? []).length;
  return Math.ceil((s.length - cjk) / 4 + cjk);
};

// A title may legitimately contain brackets (see cli/env-overrides), which
// would otherwise terminate the markdown link early.
const mdText = (s) => s.replace(/([[\]])/g, "\\$1");

const HOME_MD = [
  "# wdl.md — WDL documentation",
  "",
  DESCRIPTION,
  "",
  "Every page is also served as markdown: append `.md` to its URL or request",
  `it with \`Accept: text/markdown\`. Machine-readable index: ${SITE_URL}llms.txt`,
  "",
  ...navSections.flatMap(({ section, pages }) => [
    `## ${section}`,
    "",
    ...pages.flatMap((p) => [
      `- [${mdText(p.en.title)}](${SITE_ORIGIN}/${p.slug}.md)`,
      ...(p.zh ? [`- [${mdText(p.zh.title)}](${SITE_ORIGIN}/zh/${p.slug}.md) (中文)`] : []),
    ]),
    "",
  ]),
].join("\n");

// The two token headers compare this document against the HTML the same URL
// serves. Both count fixed build output, so each pair is measured once per page
// and language rather than on every request.
const tokenCounts = new Map();
function tokensFor(page, lang) {
  const key = `${lang}:${page.slug}`;
  let counts = tokenCounts.get(key);
  if (!counts) {
    counts = {
      markdown: estimateTokens(variant(page, lang).markdown),
      html: estimateTokens(renderDocPage(page, lang, LOCAL_ASSETS)),
    };
    tokenCounts.set(key, counts);
  }
  return counts;
}
const HOME_TOKENS = {
  markdown: estimateTokens(HOME_MD),
  html: estimateTokens(renderHomePage(LOCAL_ASSETS)),
};

// ---- crawler files ----

const CRAWLER_FILES = {
  "/robots.txt": {
    type: "text/plain; charset=utf-8",
    body: `# AI crawlers (GPTBot, ClaudeBot, PerplexityBot, and friends) are welcome.
User-agent: *
Allow: /

Sitemap: ${SITE_URL}sitemap.xml
`,
  },
  "/sitemap.xml": {
    type: "application/xml; charset=utf-8",
    // Slugs come from upstream filenames, so they are escaped: one raw & would
    // make the whole document unparseable and drop every URL from the index.
    body: `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${["", ...PAGES.flatMap((p) => (p.zh ? [p.slug, `zh/${p.slug}`] : [p.slug]))]
  .map((slug) => `  <url><loc>${escape(SITE_URL + slug)}</loc></url>`)
  .join("\n")}
</urlset>
`,
  },
  "/llms.txt": {
    type: "text/plain; charset=utf-8",
    body: [
      "# wdl.md — WDL documentation index",
      `# ${DESCRIPTION}`,
      "# Append .md to any page URL (or send Accept: text/markdown) for its markdown source.",
      "",
      ...navSections.flatMap(({ section, pages }) => [
        `## ${section}`,
        ...pages.flatMap((p) => [
          `- ${p.en.title}: ${SITE_URL}${p.slug}`,
          ...(p.zh ? [`- ${p.zh.title} (中文): ${SITE_URL}zh/${p.slug}`] : []),
        ]),
        "",
      ]),
    ].join("\n"),
  },
};

// ---- responses ----
// Header groups shared by more than one response shape below.

const NOSNIFF = { "x-content-type-options": "nosniff" };
// The daily build already leaves a document up to a day old, so a short cache
// bought freshness it never had; revalidation happens behind the reader.
const CACHEABLE = { "cache-control": "public, max-age=21600, stale-while-revalidate=86400" };
// A cached redirect would pin a short link to whatever it meant that day.
const UNCACHED = { "cache-control": "no-store" };

const html = (body) =>
  new Response(body, {
    headers: {
      ...NOSNIFF, ...CACHEABLE,
      "content-type": "text/html; charset=utf-8",
      // The same URL serves markdown to agents that ask for it.
      "vary": "accept",
    },
  });

// The .md twin of a page is the same document, so it points search engines at
// the HTML URL rather than competing with it.
const markdown = (body, tokens, canonical) =>
  new Response(body, {
    headers: {
      ...NOSNIFF, ...CACHEABLE,
      "content-type": "text/markdown; charset=utf-8",
      "vary": "accept",
      "link": `<${canonical}>; rel="canonical"`,
      "x-markdown-tokens": String(tokens.markdown),
      "x-original-tokens": String(tokens.html),
      "content-signal": "ai-train=yes, search=yes, ai-input=yes",
    },
  });

// Same-content redirects preserve the query, like the canonical-host 301.
const redirect = (location, search = "") =>
  new Response(null, {
    status: 302,
    headers: { ...UNCACHED, location: beforeFragment(location, search) },
  });

const plain = (body, status) =>
  new Response(body, {
    status,
    headers: { ...NOSNIFF, ...UNCACHED, "content-type": "text/plain; charset=utf-8" },
  });

const notFound = () => plain("Not found\n", 404);

// ---- routing ----
// Ordering carries meaning here: every rule below assumes the ones above it
// have already run, which is what keeps each redirect a single hop.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    // Every route here is a document read; answering a POST with the page is
    // worse than saying so.
    if (request.method !== "GET" && request.method !== "HEAD") {
      const res = plain("Method not allowed\n", 405);
      res.headers.set("allow", "GET, HEAD");
      return res;
    }
    if (pathname === HEALTH_PATH) {
      const res = plain("ok", 200);
      res.headers.set("x-robots-tag", "noindex");
      return res;
    }
    // Health above answers on the platform domain; everything else
    // consolidates onto the canonical host, except loopback, where a redirect
    // to production would make a local run impossible to look at. The target
    // is rebuilt from SITE_URL because the gateway terminates TLS — the
    // incoming scheme (plain http) must not leak into Location.
    if (url.hostname !== SITE_HOST && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname)) {
      const target = new URL(SITE_URL);
      target.pathname = pathname;
      target.search = url.search;
      return Response.redirect(target, 301);
    }
    // Leading slashes collapse as well as trailing ones: `//example.com` is a
    // legal pathname, and echoing it into Location would be a protocol-relative
    // redirect off this origin. Normalising here keeps that impossible in the
    // worker rather than relying on the gateway to merge slashes first.
    const clean = pathname.replace(/^\/+/, "/").replace(/\/+$/, "") || "/";
    if (REDIRECTS[clean]) return redirect(REDIRECTS[clean], url.search);
    // The zh tree has no home of its own; send both spellings to the index.
    if (clean === "/zh") return redirect("/", url.search);
    if (clean === "/zh.md" || clean === "/zh/index.md") return redirect("/index.md", url.search);
    // One URL per page. This sits after the rules above so a slashed short
    // link still reaches its target in a single hop.
    if (clean !== pathname) return redirect(clean, url.search);

    const crawlerFile = CRAWLER_FILES[clean];
    if (crawlerFile) {
      return new Response(crawlerFile.body, {
        headers: { ...NOSNIFF, ...CACHEABLE, "content-type": crawlerFile.type },
      });
    }

    // "/.md" is excluded: its slug is empty, and stripping the suffix would
    // otherwise land it on the home page instead of a 404.
    const viaSuffix = clean.endsWith(".md") && clean !== "/.md";
    const route = clean === "/index.md" ? "/" : viaSuffix ? clean.slice(0, -3) : clean;
    const asMarkdown = viaSuffix || wantsMarkdown(request);

    // Short links compose with the .md suffix: /deploy.md → /cli/deploy.md.
    if (viaSuffix && REDIRECTS[route]) {
      return redirect(beforeFragment(REDIRECTS[route], ".md"), url.search);
    }

    if (route === "/") {
      return asMarkdown
        ? markdown(HOME_MD, HOME_TOKENS, SITE_URL)
        : html(renderHomePage(await assetUrls(env)));
    }

    const zh = route.startsWith("/zh/");
    const slug = zh ? route.slice(4) : route.slice(1);
    const page = BY_SLUG.get(slug);
    if (!page) return notFound();
    if (zh && !page.zh) return redirect(viaSuffix ? `/${slug}.md` : `/${slug}`, url.search);

    const lang = zh ? "zh" : "en";
    return asMarkdown
      ? markdown(variant(page, lang).markdown, tokensFor(page, lang), pageUrl(slug, lang))
      : html(renderDocPage(page, lang, await assetUrls(env)));
  },
};
