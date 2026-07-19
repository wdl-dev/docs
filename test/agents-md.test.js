// The markdown-for-agents contract as it is served: Accept negotiation, the
// `.md` suffix, and what the document itself carries. The rewriter that built
// those documents is tested in markdown.test.js; here it appears only as a
// probe, re-run over the output to prove nothing was left unresolved.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { rewriteMarkdownLinks } from "../scripts/markdown.mjs";
import { PAGES } from "../src/content.gen.js";

// Derived, never named: a page gains a translation upstream and a hardcoded
// slug would turn that into a test failure.
const ONLY_EN = PAGES.find((p) => !p.zh).slug;

const get = (path, headers = {}) =>
  worker.fetch(new Request(`https://wdl.md${path}`, { headers }), {});

test(".md suffix returns markdown with frontmatter and source pointer", async () => {
  const res = await get("/platform/architecture.md");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/markdown; charset=utf-8");
  const body = await res.text();
  assert.ok(body.startsWith("---\ntitle: "));
  assert.ok(body.includes("canonical: https://wdl.md/platform/architecture"));
  // Both pin the ref the text came from — a release tag in CI, a branch
  // locally — so neither may be hardcoded here.
  const ref = PAGES.find((p) => p.slug === "platform/architecture").ref;
  assert.ok(body.includes(`ref: "${ref}"`));
  assert.ok(body.includes(`source: https://github.com/wdl-dev/wdl/blob/${ref}/docs/architecture.md`));
});

test("Accept: text/markdown negotiates markdown; text/html stays HTML; both Vary", async () => {
  const md = await get("/platform/architecture", { accept: "text/markdown" });
  assert.equal(md.headers.get("content-type"), "text/markdown; charset=utf-8");
  const htmlRes = await get("/platform/architecture", { accept: "text/html" });
  assert.ok((await htmlRes.text()).startsWith("<!DOCTYPE html>"));
  assert.equal(md.headers.get("vary"), "accept");
  assert.equal(htmlRes.headers.get("vary"), "accept");
});

test("agent headers: token estimates and content-signal", async () => {
  const res = await get("/cli/guide.md");
  const mdTokens = Number(res.headers.get("x-markdown-tokens"));
  const htmlTokens = Number(res.headers.get("x-original-tokens"));
  // Both are estimates of real payloads; their ratio is content-dependent
  // (aligned tables make some markdown sources larger than their HTML).
  assert.ok(mdTokens > 0 && htmlTokens > 0);
  assert.equal(res.headers.get("content-signal"), "ai-train=yes, search=yes, ai-input=yes");
});

test("an explicit q=0 refuses markdown", async () => {
  const refused = await get("/cli/guide", { accept: "text/html, text/markdown;q=0" });
  assert.equal(refused.headers.get("content-type"), "text/html; charset=utf-8");
  const asked = await get("/cli/guide", { accept: "text/markdown;q=0.9" });
  assert.equal(asked.headers.get("content-type"), "text/markdown; charset=utf-8");
});

test("relative cross-doc links in markdown output become absolute .md URLs", async () => {
  const body = await (await get("/platform/architecture.md")).text();
  assert.ok(/\]\(https:\/\/wdl\.md\/platform\/[a-z-]+\.md[)#]/.test(body));
  // Re-running the rewriter over the output must find nothing left to resolve.
  let unresolved = 0;
  rewriteMarkdownLinks(body, (href) => { unresolved += 1; return href; });
  assert.equal(unresolved, 0);
});

test("/index.md serves a markdown section index", async () => {
  // The home page negotiates too, so the same index answers Accept alone.
  const negotiated = await get("/", { accept: "text/markdown" });
  assert.equal(negotiated.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.equal(negotiated.headers.get("link"), '<https://wdl.md/>; rel="canonical"');

  const body = await (await get("/index.md")).text();
  assert.ok(body.startsWith("# wdl.md"));
  assert.ok(body.includes("## CLI"));
  assert.ok(body.includes("(https://wdl.md/cli/guide.md)"));
});

test("zh markdown variant works; missing zh redirects keeping the suffix", async () => {
  const zh = await get("/zh/cli/guide.md");
  assert.equal(zh.status, 200);
  assert.ok((await zh.text()).includes("canonical: https://wdl.md/zh/cli/guide"));
  const miss = await get(`/zh/${ONLY_EN}.md`);
  assert.equal(miss.status, 302);
  assert.equal(miss.headers.get("location"), `/${ONLY_EN}.md`);
});

test("zh cross-doc links resolve on-site, not to GitHub", async () => {
  const html = await (await get("/zh/platform/architecture")).text();
  assert.ok(html.includes('href="/zh/platform/modules/'));
  assert.ok(!html.includes("blob/main/docs/modules/gateway.zh.md"));
  const md = await (await get("/zh/platform/architecture.md")).text();
  assert.ok(md.includes("https://wdl.md/zh/platform/modules/"));
});

test("short links compose with the .md suffix", async () => {
  const res = await get("/deploy.md");
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/cli/deploy.md");
  const init = await get("/init.md");
  assert.equal(init.headers.get("location"), "/cli/guide.md#scaffolding-a-new-worker");
});

test("same-content redirects preserve the query string", async () => {
  assert.equal((await get("/d1?utm=cli")).headers.get("location"), "/cli/d1?utm=cli");
  // query goes before an existing fragment
  assert.equal((await get("/init?x=1")).headers.get("location"),
    "/cli/guide?x=1#scaffolding-a-new-worker");
  // zh-missing fallback keeps it too
  assert.equal((await get(`/zh/${ONLY_EN}?x=1`)).headers.get("location"), `/${ONLY_EN}?x=1`);
});

test("a trailing slash redirects, in one hop", async () => {
  for (const [from, to] of [
    ["/cli/guide/", "/cli/guide"],
    ["/robots.txt/", "/robots.txt"],
    ["/zh/", "/"],
    ["/d1/", "/cli/d1"],
  ]) {
    const res = await get(from);
    assert.equal(res.status, 302, from);
    assert.equal(res.headers.get("location"), to, from);
    // the target itself must not redirect again
    assert.equal((await get(to)).status === 302, false, `${to} redirects again`);
  }
});

test("/zh and /zh/index.md land on the index", async () => {
  assert.equal((await get("/zh")).headers.get("location"), "/");
  assert.equal((await get("/zh/")).headers.get("location"), "/");
  assert.equal((await get("/zh/index.md")).headers.get("location"), "/index.md");
  assert.equal((await get("/zh.md")).headers.get("location"), "/index.md");
});

test("zh token estimates weight CJK characters", async () => {
  const res = await get("/zh/cli/guide.md");
  const body = await res.text();
  assert.ok(Number(res.headers.get("x-markdown-tokens")) > body.length / 4);
});

test("unknown .md path is a plain 404, and browsers still get HTML", async () => {
  assert.equal((await get("/nope/nothing.md")).status, 404);
  const res = await get("/platform/architecture", {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  });
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
});
