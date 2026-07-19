// The build's own reading of a source doc: what becomes a title, a description,
// and where a relative link points. These run on fixtures rather than the real
// corpus, so a branch the corpus happens not to exercise is still pinned.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  makeIndex, makeResolveLink, plainText, stripHtmlComments, summaryOf, titleOf, yamlStr,
} from "../scripts/build-content.mjs";

// ---- reading a source doc ----

test("plainText unwraps inline markdown, innermost image first", () => {
  assert.equal(plainText("`wdl deploy` and **bold** and *it* and ~~gone~~"),
    "wdl deploy and bold and it and gone");
  assert.equal(plainText("[docs](x.md)"), "docs");
  // A badge is an image inside a link; taking links first would strand brackets.
  assert.equal(plainText("[![CI](b.svg)](ci.yml)"), "CI");
});

test("titleOf reads the first prose h1, never one inside a fence", () => {
  assert.equal(titleOf("# Real Title\n\ntext", "fallback"), "Real Title");
  assert.equal(titleOf("```sh\n# not a title\n```\n\n# Real\n", "fallback"), "Real");
  assert.equal(titleOf("no heading here", "fallback"), "fallback");
  assert.equal(titleOf("# `wdl d1` — **the** database", "x"), "wdl d1 — the database");
});

test("summaryOf takes the first paragraph that actually describes the page", () => {
  // A language switcher is prose by every structural test but says nothing;
  // the length floor is what rejects it.
  const md = "# Title\n\n[English](./x.md) | 中文\n\n" +
    "This paragraph is long enough to describe the page and should be chosen.\n";
  assert.equal(summaryOf(md), "This paragraph is long enough to describe the page and should be chosen.");

  // Headings, bullets, quotes and tables are structure, not description.
  assert.equal(summaryOf("# T\n\n- a bullet that is quite long but still a bullet item\n"), "");

  // A paragraph may open with bold — a bullet marker needs a space after it.
  assert.ok(summaryOf("# T\n\n**Note:** this sentence is long enough to be a real summary line.")
    .startsWith("Note: this"));

  // Truncation lands on a word boundary and marks itself.
  const long = `# T\n\n${"word ".repeat(60)}\n`;
  const out = summaryOf(long);
  assert.ok(out.length <= 156 && out.endsWith("…"), out);
  assert.ok(!out.includes("wor…"), "cut mid-word");
});

test("stripHtmlComments drops comments from prose, never from code", () => {
  assert.equal(stripHtmlComments("a <!-- hidden --> b"), "a  b");
  assert.ok(stripHtmlComments("```\n<!-- kept -->\n```").includes("<!-- kept -->"));
  // A code span holding the delimiters is documentation about comments.
  assert.ok(stripHtmlComments("use `<!-- x -->` here").includes("`<!-- x -->`"));
});

test("a comment after an unmatched backtick is still stripped", () => {
  // The code-span guard must not span a blank line, or the comment hides inside
  // a fake span and renders as visible escaped text.
  assert.ok(!stripHtmlComments("a ` b\n\n<!-- internal -->\n\nc ` d").includes("<!--"));
});

// ---- link resolution ----

const PAGES = [
  { slug: "cli/token", repo: "cli", path: "docs/token.md", zhPath: "docs/token-zh.md", zhSource: "zh" },
  { slug: "cli/deploy", repo: "cli", path: "docs/deploy.md", zhPath: "docs/deploy-zh.md", zhSource: "zh" },
  { slug: "lib/sigv4", repo: "sigv4", path: "README.md", zhPath: null, zhSource: null },
];
const index = makeIndex(PAGES);
const resolve = (page, lang, absolute = false) => makeResolveLink(index, page, lang, absolute);
const [token, , sigv4] = PAGES;

test("a relative target becomes a site route; an unaggregated one goes to GitHub", () => {
  assert.equal(resolve(token, "en")("./deploy.md"), "/cli/deploy");
  // No ref on these fixtures, so the fallback branch is what is linked.
  assert.equal(resolve(token, "en")("../CHANGELOG.md"),
    "https://github.com/wdl-dev/cli/blob/main/CHANGELOG.md");
});

test("a repo's ref comes off the pages, not off the checkout beside them", () => {
  // Otherwise this resolver would answer differently on different machines.
  const pinned = PAGES.map((p) => ({ ...p, ref: "v9.9.9" }));
  const out = makeResolveLink(makeIndex(pinned), pinned[0], "en", false)("../CHANGELOG.md");
  assert.equal(out, "https://github.com/wdl-dev/cli/blob/v9.9.9/CHANGELOG.md");
});

test("reading in zh stays in zh, except the page's own English source", () => {
  // A different doc: keep the reader in Chinese.
  assert.equal(resolve(token, "zh")("./deploy.md"), "/zh/cli/deploy");
  // This same doc's English source: that is the language switcher itself.
  assert.equal(resolve(token, "zh")("./token.md"), "/cli/token");
  // A page with no translation is linked in English whatever the reader wants.
  assert.equal(resolve(token, "zh")("../../sigv4/README.md"), "/lib/sigv4");
});

test("a zh doc resolves relative to the zh source, not its English sibling", () => {
  // token-zh.md and token.md sit in the same directory here, so the give-away
  // is that resolution succeeds at all rather than climbing out of docs/.
  assert.equal(resolve(token, "zh")("./deploy-zh.md"), "/zh/cli/deploy");
});

test("query and fragment survive resolution, in that order", () => {
  assert.equal(resolve(token, "en")("./deploy.md#step-2"), "/cli/deploy#step-2");
  assert.equal(resolve(token, "en")("./deploy.md?download=1#step-2"), "/cli/deploy?download=1#step-2");
  assert.equal(resolve(token, "en", true)("./deploy.md?a=1#b"),
    "https://wdl.md/cli/deploy.md?a=1#b");
  // A bare fragment addresses this page and needs no resolving.
  assert.equal(resolve(token, "en")("#section"), "#section");
});

test("the agent copy gets absolute .md URLs", () => {
  assert.equal(resolve(sigv4, "en", true)("../cli/docs/token.md"), "https://wdl.md/cli/token.md");
});

// ---- the build ----

test("yamlStr escapes what would otherwise break the frontmatter", () => {
  assert.equal(yamlStr('He said "hi"'), '"He said \\"hi\\""');
  assert.equal(yamlStr("back\\slash"), '"back\\\\slash"');
});
