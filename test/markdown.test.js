// What this site adds on top of CommonMark: the escaping boundary, heading
// anchors, link resolution, the two shapes the stylesheet depends on, and the
// source-level rewriter behind the `.md` documents. CommonMark itself is
// markdown-it's contract, not ours, so it is not retested here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRenderer, rewriteMarkdownLinks, slugifyAnchor } from "../scripts/markdown.mjs";

const render = (md, resolveLink = (h) => h) => createRenderer(resolveLink)(md);

// ---- markdown as HTML ----

test("raw HTML is escaped, never passed through", () => {
  const html = render('hello <script>alert("x")</script> world');
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
});

test("fenced code keeps its language and escapes its contents", () => {
  const html = render('```js\nconst a = "<b>" && 1;\n```');
  assert.ok(html.includes('<pre><code class="language-js">'));
  assert.ok(html.includes("&lt;b&gt;"));
  assert.ok(html.includes("&amp;&amp;"));
  assert.ok(!html.includes("<b>"));
});

test("table cells are escaped and the table can scroll", () => {
  const html = render("| Col<a> | Two |\n| --- | --- |\n| `x` | **y** |");
  assert.ok(html.includes('<div class="table-wrap"><table>'));
  assert.ok(html.includes("<th>Col&lt;a&gt;</th>"));
  assert.ok(html.includes("<td><code>x</code></td>"));
  assert.ok(html.includes("<td><strong>y</strong></td>"));
});

test("headings get GitHub-compatible anchors, duplicates disambiguated", () => {
  const html = render("# Alpha Beta\n\n## Alpha Beta");
  assert.ok(html.includes('<h1 id="alpha-beta">'));
  assert.ok(html.includes('<h2 id="alpha-beta-1">'));
  // Runs of separators must not collapse: the corpus links #a--b fragments.
  assert.equal(slugifyAnchor("Deployment / Rollout notes"), "deployment--rollout-notes");
  assert.equal(slugifyAnchor("部署与回滚 (deploy)"), "部署与回滚-deploy");
});

test("every heading below h1 is a link to itself", () => {
  const html = render("# Page\n\n## A Section");
  // the whole heading is the target, so the link is named after the section
  assert.ok(html.includes('<h2 id="a-section"><a class="anchor" href="#a-section">A Section'));
  // the page URL already addresses the h1
  assert.ok(html.includes('<h1 id="page">Page</h1>'));
});

test("a heading that renders its own anchor is not wrapped in a second one", () => {
  // Images render as links here too, so both shapes must skip the permalink.
  for (const src of [
    "## [API docs](https://example.com/docs)",
    "## [API docs][api]\n\n[api]: https://example.com/docs",
    "## ![Diagram](arch.png)",
  ]) {
    const html = render(src, (h) => `/x/${h}`);
    assert.ok(!/<a [^>]*><a /.test(html), `anchors nested: ${src}`);
    assert.ok(!html.includes('class="anchor"'), `permalink wrapped: ${src}`);
  }
  // The id comes from the text a reader sees, not from the source: a reference
  // link's label and an inline link's URL both stay out of it.
  assert.ok(render("## [API docs][api]\n\n[api]: https://e.com").includes('<h2 id="api-docs">'));
  assert.ok(render("## ![Diagram](arch.png)").includes('<h2 id="diagram">'));
  // A Setext heading spans lines; the break separates words rather than
  // welding them together.
  assert.ok(render("Foo\nbar\n---").includes('<h2 id="foo-bar">'));
  assert.ok(render("Foo  \nbar\n---").includes('<h2 id="foo-bar">'));
});

test("relative targets resolve; absolute ones are left alone", () => {
  const seen = [];
  const html = render("[a](security.md) [b](https://example.com/x)", (href) => {
    seen.push(href);
    return "/platform/security";
  });
  assert.deepEqual(seen, ["security.md"]);
  assert.ok(html.includes('href="/platform/security"'));
  assert.ok(html.includes('href="https://example.com/x" target="_blank" rel="noopener"'));
});

test("a root-relative target is repo-relative, so it resolves too", () => {
  const seen = [];
  render("[x](/docs/internal.md)", (href) => (seen.push(href), "/site/x"));
  assert.deepEqual(seen, ["/docs/internal.md"]);
});

test("javascript: never becomes a link", () => {
  const html = render("[click](javascript:alert(1))");
  assert.ok(!/href="[^"]*javascript:/i.test(html));
  assert.ok(!html.includes("<a "));
});

test("images render as links, and a badge collapses to one anchor", () => {
  const plain = render("![diagram](arch.png)", (h) => `/resolved/${h}`);
  assert.ok(plain.includes('<a href="/resolved/arch.png">diagram</a>'));
  assert.ok(!plain.includes("<img"), "the site loads no third-party images");

  const badge = render("[![CI](https://img.shields.io/b.svg)](https://github.com/x/actions)");
  assert.ok(badge.includes('<a href="https://github.com/x/actions" target="_blank" rel="noopener">CI</a>'));
  assert.ok(!/<a [^>]*><a /.test(badge), "anchors never nest");
});

test("emphasis works inside CJK prose, where CommonMark alone would not", () => {
  assert.ok(render("只挡住了*环境*这条路").includes("<em>环境</em>"));
  assert.ok(render("**`DB 0`，控制面：**其余").includes("</strong>"));
});

// ---- markdown as text ----
// The same source, rewritten rather than rendered: what agents receive.

test("relative targets resolved, absolute and anchors untouched", () => {
  const out = rewriteMarkdownLinks(
    "[a](security.md) [b](https://example.com/x) [c](#frag) ![img](diagram.png)",
    (href) => `https://wdl.md/RESOLVED/${href}`,
  );
  assert.ok(out.includes("(https://wdl.md/RESOLVED/security.md)"));
  assert.ok(out.includes("(https://example.com/x)"));
  assert.ok(out.includes("(#frag)"));
  assert.ok(out.includes("(https://wdl.md/RESOLVED/diagram.png)"));
});

test("a badge resolves both its image and its target", () => {
  const out = rewriteMarkdownLinks(
    "[![license](https://img.shields.io/x.svg)](LICENSE) and [![ci](badge.png)](ci.yml)",
    (href) => `https://example.com/${href}`,
  );
  // both the image and the link it wraps are resolved
  assert.ok(out.includes("](https://example.com/LICENSE)"));
  assert.ok(out.includes("](https://example.com/ci.yml)"));
  // a relative image target resolves too; an absolute one is left alone
  assert.ok(out.includes("[![ci](https://example.com/badge.png)]"));
  assert.ok(out.includes("[![license](https://img.shields.io/x.svg)]"));
});

test("code spans and fenced blocks stay verbatim", () => {
  const src = "see `[x](rel.md)` and\n```\n[y](rel.md)\n```\n[z](rel.md)";
  const out = rewriteMarkdownLinks(src, () => "REWRITTEN");
  assert.ok(out.includes("`[x](rel.md)`"));
  assert.ok(out.includes("\n[y](rel.md)\n"));
  assert.ok(out.includes("[z](REWRITTEN)"));
});

test("a scheme the renderer refuses is defused in the agent copy too", () => {
  // Otherwise the two representations of a page disagree about it: the HTML
  // drops the link and the markdown still carries a live javascript: target.
  const dead = (src) => rewriteMarkdownLinks(src, (h) => `/R/${h}`);
  assert.equal(dead("[click](javascript:alert(1))"), "[click](#)");
  assert.equal(dead("![i](javascript:alert(1))"), "![i](#)");
  assert.equal(dead("[![b](javascript:a)](javascript:c)"), "[![b](#)](#)");
  assert.equal(dead("[x](data:text/html;base64,PHN2Zz4=)"), "[x](#)");
  assert.equal(dead("[x](vbscript:msgbox)"), "[x](#)");
  // The HTML side reaches the same verdict by its own route.
  assert.ok(!render("[click](javascript:alert(1))").includes("<a "));
});

test("unmatched backticks a paragraph apart are not one code span", () => {
  // `[^`]+` would pair them and skip every link in between, so the .md document
  // would keep a link the HTML page resolves — the two must not disagree.
  const doc = "a ` here\n\nSee [the guide](guide.md).\n\nclose ` there";
  assert.ok(rewriteMarkdownLinks(doc, (h) => `/R/${h}`).includes("/R/guide.md"));
  assert.ok(render(doc, (h) => `/R/${h}`).includes('href="/R/guide.md"'));
  // A span across a single line break is still legal, and still protected.
  assert.ok(rewriteMarkdownLinks("a `x\ny` b", () => "BAD").includes("`x\ny`"));
});

test("a fence only closes on a bare marker, so code samples stay verbatim", () => {
  // ```console opens no new block and closes none; everything up to the bare
  // fence is code an agent may copy unchanged.
  const doc = "A [a](x.md)\n\n```sh\n```console\n[b](y.md)\n```\n\nB [c](z.md)";
  const md = rewriteMarkdownLinks(doc, (h) => `/R/${h}`);
  assert.ok(md.includes("[b](y.md)"));
  assert.ok(md.includes("[c](/R/z.md)"));
});
