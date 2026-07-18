// The build's renderer. `html: false` is the security boundary: raw HTML in a
// source doc is escaped, never passed through. The rules below are what this
// site adds on top of CommonMark.

import MarkdownIt from "markdown-it";
import cjkFriendly from "markdown-it-cjk-friendly";

import { escape } from "../src/escape.js";

// ---- markdown as HTML ----

// Targets that are already final. A single leading slash is not among them:
// in a source doc that means repo-root-relative, so it needs resolving.
const SAFE_HREF = /^(https?:|mailto:|#|\/\/)/i;
const offSite = (href) => /^https?:/i.test(href);

// GitHub-compatible. Runs of separators must not collapse: the corpus links
// fragments like #deployment--rollout-notes.
export function slugifyAnchor(text) {
  return String(text)
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

// The heading as a reader sees it, not as it was written: a reference link's
// label never reaches the page, an image contributes its alt text, and a Setext
// heading's line breaks are word separators.
const TEXT_TOKEN = new Set(["text", "code_inline", "image"]);
const BREAK_TOKEN = new Set(["softbreak", "hardbreak"]);
const headingText = (inline) =>
  (inline.children ?? [])
    .map((c) => (TEXT_TOKEN.has(c.type) ? c.content : BREAK_TOKEN.has(c.type) ? " " : ""))
    .join("");

/** A renderer bound to one `resolveLink`, which turns a relative target into a
 *  site route or a GitHub URL. */
export function createRenderer(resolveLink) {
  const md = new MarkdownIt({ html: false, linkify: false, typographer: false })
    // CommonMark's flanking rules treat fullwidth punctuation as a boundary,
    // which leaves `**…：**` in Chinese prose unclosed and its asterisks
    // visible. This plugin applies the CJK emphasis proposal instead.
    .use(cjkFriendly);
  const rules = md.renderer.rules;
  const resolved = (href) => (SAFE_HREF.test(href) ? href : resolveLink(href));

  // Every section is addressable; below the h1 — whose address is the page URL
  // — the whole heading is the link to it, so the target is full-width and needs
  // no label to translate. Headings that already render an anchor (links, and
  // images, which this site renders as links) keep the id but not the wrapper.
  const permalinked = (tag, inline) =>
    tag !== "h1" && !inline.children?.some((c) => c.type === "link_open" || c.type === "image");

  rules.heading_open = (tokens, i, opts, env, self) => {
    const base = slugifyAnchor(headingText(tokens[i + 1])) || "section";
    const seen = (env.anchors ??= new Map());
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const id = n === 0 ? base : `${base}-${n}`;
    tokens[i].attrSet("id", id);
    const open = self.renderToken(tokens, i, opts);
    return permalinked(tokens[i].tag, tokens[i + 1]) ? `${open}<a class="anchor" href="#${id}">` : open;
  };
  rules.heading_close = (tokens, i, opts, _env, self) =>
    (permalinked(tokens[i].tag, tokens[i - 1]) ? '<span class="mark">#</span></a>' : "") +
    self.renderToken(tokens, i, opts);

  // validateLink has already refused javascript: and friends by the time this
  // runs, so the only decision left is on-site or new tab.
  rules.link_open = (tokens, i, opts, env, self) => {
    const href = resolved(tokens[i].attrGet("href") ?? "");
    tokens[i].attrSet("href", href);
    if (offSite(href)) {
      tokens[i].attrSet("target", "_blank");
      tokens[i].attrSet("rel", "noopener");
    }
    env.inLink = true;
    return self.renderToken(tokens, i, opts);
  };
  rules.link_close = (tokens, i, opts, env, self) => {
    env.inLink = false;
    return self.renderToken(tokens, i, opts);
  };

  // The corpus's images live on other hosts and this site loads none of them,
  // so an image becomes a link to it — or, inside one (a badge), just its label.
  rules.image = (tokens, i, _opts, env) => {
    const src = tokens[i].attrGet("src") ?? "";
    const label = escape(tokens[i].content || src);
    if (env.inLink) return label;
    const href = escape(resolved(src));
    const attrs = offSite(href) ? ' target="_blank" rel="noopener"' : "";
    return `<a href="${href}"${attrs}>${label}</a>`;
  };

  // Wide tables scroll inside their own box rather than the page.
  rules.table_open = () => '<div class="table-wrap"><table>';
  rules.table_close = () => "</table></div>";

  return (source) => md.render(String(source), {});
}

// ---- markdown as text ----
// The `.md` documents and the corpus checks work on the source rather than on
// rendered output, so where code begins and ends is defined once, here.

// Any indent: a fence nested in a list sits further in than the three spaces
// CommonMark allows at top level, and treating it as prose would rewrite links
// inside a code sample.
const FENCE_OPEN = /^\s*(`{3,}|~{3,})(.*)$/;

const openFence = (line) => {
  const m = FENCE_OPEN.exec(line);
  // A backtick fence's info string may not itself contain a backtick.
  return !m || (m[1][0] === "`" && m[2].includes("`")) ? null : m[1];
};

const closesFence = (line, marker) => {
  const t = line.trim();
  return t.length >= marker.length && [...t].every((c) => c === marker[0]);
};

/** Run `fn` over each run of prose; fenced blocks pass through verbatim. */
export function mapProse(md, fn) {
  const out = [];
  let prose = [];
  let fence = null;
  const flush = () => {
    if (prose.length) { out.push(fn(prose.join("\n"))); prose = []; }
  };
  for (const line of String(md).replace(/\r\n/g, "\n").split("\n")) {
    if (fence) {
      out.push(line);
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    const marker = openFence(line);
    if (marker) { flush(); out.push(line); fence = marker; continue; }
    prose.push(line);
  }
  flush();
  return out.join("\n");
}

// A code span may hold a line break but not a blank line — that ends the
// paragraph. Without the restriction two unmatched backticks paragraphs apart
// pair into one, and every link between them is left unresolved.
const CODE_SPAN = /(`+(?:[^`\n]|\n(?!\s*\n))+`+)/;

/** Apply `fn` to the parts of a prose run that are not inline code. */
export const mapOutsideCode = (text, fn) =>
  text.split(CODE_SPAN).map((part, i) => (i % 2 ? part : fn(part))).join("");

// No `^\s*`: DEST below cannot match a target with leading whitespace, so such
// a link never reaches this test.
const UNSAFE_SCHEME = /^(javascript|data|vbscript):/i;
// A destination ends at the closing paren but may hold a balanced pair, so
// that URLs like .../Foo_(bar) match in full.
const DEST = String.raw`(?:[^()\s]|\([^()\s]*\))+`;
const TITLE = String.raw`(?:\s+"[^"]*")?`;
// A badge keeps its nested shape in markdown, and both of its targets need
// resolving — LINK alone matches only the inner image.
const BADGE = new RegExp(String.raw`(\[!\[[^\]]*\]\()(${DEST})(${TITLE}\)\]\()(${DEST})(${TITLE}\))`, "g");
const LINK = new RegExp(String.raw`(!?\[[^\]]*\]\()(${DEST})(${TITLE}\))`, "g");

/** Rewrite relative targets in markdown source — fenced blocks and code spans
 *  untouched — so no agent receives a link that only resolved in the source repo. */
export function rewriteMarkdownLinks(md, resolveLink) {
  // A scheme the renderer refuses must not survive here either, or the two
  // representations of a page disagree about it.
  const resolve = (target) =>
    UNSAFE_SCHEME.test(target) ? "#" : SAFE_HREF.test(target) ? target : resolveLink(target);
  return mapProse(md, (text) =>
    mapOutsideCode(text, (part) =>
      part
        .replace(BADGE, (_, a, img, b, target, c) => `${a}${resolve(img)}${b}${resolve(target)}${c}`)
        .replace(LINK, (_, open, target, close) => `${open}${resolve(target)}${close}`)));
}
