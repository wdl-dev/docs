// Everything the worker serves, as it comes off the wire: routing and
// redirects, the crawler files, the head, the page shell, and the corpus
// rendered into it. The build-time renderer behind that corpus is tested in
// markdown.test.js, and the agent contract in agents-md.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { PAGES } from "../src/content.gen.js";

const get = (path, headers = {}, host = "wdl.md") =>
  worker.fetch(new Request(`https://${host}${path}`, { headers }), {});

const SITE = "https://wdl.md/";

const jsonLdOf = (html) => {
  const m = html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s);
  assert.ok(m, "JSON-LD script tag present");
  return JSON.parse(m[1]);
};

// ---- routing and methods ----

test("non-canonical hosts get a 301 preserving path and query", async () => {
  const res = await get("/cli/guide?x=1", {}, "site.wdl.sh");
  assert.equal(res.status, 301);
  assert.equal(res.headers.get("location"), "https://wdl.md/cli/guide?x=1");
});

test("a redirect never leaves this origin", async () => {
  // `//example.com` is a legal pathname; echoed into Location it would be a
  // protocol-relative redirect off-site.
  const res = await get("//example.com/");
  assert.equal(res.status, 302);
  assert.ok(!res.headers.get("location").startsWith("//"), "protocol-relative Location");
  assert.equal(res.headers.get("location"), "/example.com");
});

test("only reads are answered", async () => {
  const res = await worker.fetch(new Request("https://wdl.md/cli/guide", { method: "POST" }), {});
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "GET, HEAD");
});

test("loopback is exempt from the canonical-host redirect", async () => {
  // Otherwise a local run would bounce every request to production and be
  // impossible to look at.
  for (const host of ["localhost:8787", "127.0.0.1:8787", "[::1]:8787"]) {
    const res = await get("/cli/guide", {}, host);
    assert.equal(res.status, 200, host);
  }
});

test("HEAD is routed like GET", async () => {
  // Stripping the body is the runtime's job; what this pins is that HEAD is not
  // turned away by the method check above it.
  const res = await worker.fetch(new Request("https://wdl.md/cli/guide", { method: "HEAD" }), {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
});

test("documents are cacheable; routing and errors are not", async () => {
  for (const path of ["/", "/cli/guide", "/cli/guide.md", "/robots.txt", "/sitemap.xml"]) {
    const res = await get(path);
    assert.equal(res.headers.get("cache-control"),
      "public, max-age=21600, stale-while-revalidate=86400", path);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff", path);
  }
  for (const path of ["/guide", "/nope", "/_worker-healthz"]) {
    assert.equal((await get(path)).headers.get("cache-control"), "no-store", path);
  }
});

test("health answers on the platform domain, noindexed", async () => {
  const res = await get("/_worker-healthz", {}, "site.wdl.sh");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-robots-tag"), "noindex");
});

test("/init redirects to an anchor that exists in the rendered guide", async () => {
  const target = (await get("/init")).headers.get("location");
  const [path, frag] = target.split("#", 2);
  assert.equal(path, "/cli/guide");
  const html = await (await get(path)).text();
  assert.ok(html.includes(`id="${frag}"`));
});

// ---- what crawlers and agents are given ----

test("robots.txt welcomes crawlers and points at the sitemap", async () => {
  const res = await get("/robots.txt");
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.ok(body.includes("Allow: /"));
  assert.ok(body.includes("Sitemap: https://wdl.md/sitemap.xml"));
});

test("sitemap.xml lists home plus every en and zh page", async () => {
  const res = await get("/sitemap.xml");
  assert.equal(res.headers.get("content-type"), "application/xml; charset=utf-8");
  const body = await res.text();
  const expected = 1 + PAGES.length + PAGES.filter((p) => p.zh).length;
  assert.equal((body.match(/<loc>/g) ?? []).length, expected);
  assert.ok(body.includes("<loc>https://wdl.md/cli/guide</loc>"));
  assert.ok(body.includes("<loc>https://wdl.md/zh/cli/guide</loc>"));
});

test("llms.txt indexes every page in both languages", async () => {
  const res = await get("/llms.txt");
  assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
  const body = await res.text();
  for (const p of PAGES) {
    assert.ok(body.includes(`${SITE}${p.slug}`), `${p.slug} missing`);
    if (p.zh) assert.ok(body.includes(`${SITE}zh/${p.slug}`), `zh/${p.slug} missing`);
  }
  assert.ok(body.includes("Append .md to any page URL"));
});

// ---- the head: canonical, alternates, cards, JSON-LD ----

test("doc pages carry canonical, og:url, and hreflang alternates when bilingual", async () => {
  const html = await (await get("/platform/architecture")).text();
  assert.ok(html.includes('<link rel="canonical" href="https://wdl.md/platform/architecture">'));
  assert.ok(html.includes('<meta property="og:url" content="https://wdl.md/platform/architecture">'));
  assert.ok(html.includes('hreflang="zh" href="https://wdl.md/zh/platform/architecture"'));
  assert.ok(html.includes('hreflang="x-default" href="https://wdl.md/platform/architecture"'));

  const en = await (await get(`/${PAGES.find((p) => !p.zh).slug}`)).text();
  assert.ok(!en.includes("hreflang"), "no alternates for a page without a zh variant");
});

test(".md twins point back at the HTML page as canonical", async () => {
  const res = await get("/cli/guide.md");
  assert.equal(res.headers.get("link"), '<https://wdl.md/cli/guide>; rel="canonical"');
});

test("link previews carry an image card", async () => {
  const html = await (await get("/")).text();
  assert.ok(html.includes('<meta property="og:image"'));
  assert.ok(html.includes('<meta name="twitter:card" content="summary_large_image">'));
});

test("Organization and WebSite on every page, TechArticle on doc pages", async () => {
  const home = jsonLdOf(await (await get("/")).text());
  const homeTypes = home["@graph"].map((n) => n["@type"]);
  assert.deepEqual(homeTypes, ["Organization", "WebSite"]);
  assert.equal(home["@graph"][0].logo, "/logo.png");

  const zhDoc = jsonLdOf(await (await get("/zh/cli/guide")).text());
  const article = zhDoc["@graph"].find((n) => n["@type"] === "TechArticle");
  assert.ok(article);
  assert.equal(article.inLanguage, "zh");
  assert.equal(article.url, "https://wdl.md/zh/cli/guide");
  assert.equal(article.isPartOf.url, "https://wdl.md/");
});

test("every page describes itself", async () => {
  const seen = new Map();
  for (const p of PAGES) {
    for (const [path, v] of [[`/${p.slug}`, p.en], ...(p.zh ? [[`/zh/${p.slug}`, p.zh]] : [])]) {
      assert.ok(v.summary.length >= 40, `${path}: summary too short to describe the page`);
      // A bare [bracket] is legitimate prose; an unresolved link or image is not.
      assert.ok(!/!\[|\]\(/.test(v.summary), `${path}: markdown leaked into the summary`);
      seen.set(v.summary, (seen.get(v.summary) ?? 0) + 1);
    }
  }
  const shared = [...seen].filter(([, n]) => n > 1);
  assert.deepEqual(shared, [], "no two pages may share a description");
  // Every assertion above is inside the loop, so an empty corpus would pass.
  assert.equal(seen.size, PAGES.length + PAGES.filter((p) => p.zh).length);
});

// ---- the page shell ----

test("sidebar toggle is wired to the nav it controls", async () => {
  const html = await (await get("/cli/guide")).text();
  assert.ok(html.includes('aria-controls="sidenav"'));
  assert.ok(html.includes('id="sidenav"'));
  // No static aria-expanded: the real state (compact drawer, restored nav
  // preference) is client-only, so the server must not assert a wrong one.
  assert.ok(!/nav-toggle[^>]*aria-expanded/.test(html));
  // The mobile drawer's scrim ships with the sidebar, not on the solo home.
  assert.ok(html.includes('class="scrim"'));
  assert.ok(!(await (await get("/")).text()).includes('class="scrim"'));
  // The drawer can take focus, and without JS the nav is still reachable.
  assert.ok(html.includes('id="sidenav" tabindex="-1"'));
  assert.ok(html.includes("<noscript><style>"));
});

test("the drawer button names itself, in the page's language", async () => {
  // On a phone this button is the only route to the rest of the site, so it
  // must say what it opens rather than rely on a bare glyph.
  assert.ok((await (await get("/cli/guide")).text()).includes('<span class="nav-text">Contents</span>'));
  assert.ok((await (await get("/zh/cli/guide")).text()).includes('<span class="nav-text">目录</span>'));
});

test("a page names the version it was built from, and links to it", async () => {
  const html = await (await get("/cli/guide")).text();
  const row = /<p class="edit-row">[\s\S]*?<\/p>/.exec(html)[0];
  assert.ok(row.includes("/blob/main/GUIDE.md"), "edit link left the default branch");
  const ref = PAGES.find((p) => p.slug === "cli/guide").ref;
  assert.ok(row.includes(`href="${PAGES.find((p) => p.slug === "cli/guide").refUrl}"`));
  assert.ok(row.includes(`>${ref}</a>`), `version ${ref} not shown`);
  for (const p of PAGES) assert.ok(p.ref && p.refUrl, `${p.slug}: no ref`);
});

test("favicon is linked from every page", async () => {
  const html = await (await get("/")).text();
  assert.ok(html.includes('<link rel="icon" href="/favicon.svg">'));
});

test("home cards name the section's first page", async () => {
  const html = await (await get("/")).text();
  assert.ok(!html.includes("undefined"), "no unrendered field leaked into the cards");
  for (const { section, first } of [
    { section: "Platform", first: PAGES.find((p) => p.section === "Platform").en.title },
    { section: "CLI", first: PAGES.find((p) => p.section === "CLI").en.title },
  ]) {
    assert.ok(html.includes(section), `${section} card missing`);
    assert.ok(html.includes(first), `${section} card should name ${first}`);
  }
});

// ---- the corpus, as rendered ----

test("every page in the corpus renders clean", async () => {
  let checked = 0;
  for (const p of PAGES) {
    for (const path of [`/${p.slug}`, ...(p.zh ? [`/zh/${p.slug}`] : [])]) {
      const html = await (await get(path)).text();
      assert.ok(html.includes("<article>"), `${path}: no article`);
      // A leaked source comment arrives escaped, so that is the form to look
      // for — the raw one is unreachable with html:false and would never fail.
      assert.ok(!html.includes("&lt;!--"), `${path}: source comment reached the page`);
      assert.ok(!/<a [^>]*><a /.test(html), `${path}: nested anchor`);
      // Raw HTML upstream is escaped, not stripped, and the build reports it
      // rather than failing — so what is asserted here is that it cannot become
      // markup, never that a source doc is free of it.
      checked += 1;
    }
  }
  assert.equal(checked, PAGES.length + PAGES.filter((p) => p.zh).length);
});

test("a zh page's English link leaves the zh tree", async () => {
  // Most links from a zh page stay in Chinese, but a doc's own language
  // switcher points at its English source and must not resolve back to itself.
  let checked = 0;
  for (const p of PAGES.filter((x) => x.zh)) {
    for (const [, href] of p.zh.html.matchAll(/<a href="([^"]+)"[^>]*>English<\/a>/g)) {
      assert.ok(!href.startsWith("/zh/"), `/zh/${p.slug}: English link points to ${href}`);
      checked += 1;
    }
  }
  assert.ok(checked > 0, "no language switcher found — the assertion would pass vacuously");
});

test("section links point at real ids on the same page", async () => {
  for (const path of ["/platform/architecture", "/zh/platform/architecture"]) {
    const html = await (await get(path)).text();
    const anchors = [...html.matchAll(/<a class="anchor" href="#([^"]+)"/g)];
    assert.ok(anchors.length > 0, `${path}: no section links`);
    for (const [, id] of anchors) {
      assert.ok(html.includes(`id="${id}"`), `${path}: #${id} has no target`);
    }
  }
});

// ---- the asset binding ----

test("a real ASSETS binding supplies the asset URLs", async () => {
  // The mock records what it was asked for: the platform normalises either
  // spelling, but this pins which one this worker actually sends.
  const asked = [];
  const env = { ASSETS: { url: async (f) => (asked.push(f), `https://assets.example/${f}`) } };
  const res = await worker.fetch(new Request("https://wdl.md/cli/guide"), env);
  const html = await res.text();
  assert.ok(html.includes('href="https://assets.example/styles.css"'));
  assert.ok(html.includes('href="https://assets.example/favicon.svg"'));
  assert.ok(html.includes('content="https://assets.example/og.png"'));
  assert.deepEqual(asked.sort(), ["favicon.svg", "logo.png", "og.png", "styles.css"]);
});

test("a failing ASSETS binding degrades to local paths, not a 500", async () => {
  // Both shapes of failure: a rejected promise, and a binding that throws
  // before returning one — the second escapes the handler unless the calls are
  // made inside the async body.
  for (const url of [
    async () => { throw new Error("store down"); },
    () => { throw new Error("store down"); },
  ]) {
    const res = await worker.fetch(new Request("https://wdl.md/cli/guide"), { ASSETS: { url } });
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes('href="/styles.css"'));
  }
});
