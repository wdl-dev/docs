// Aggregates markdown from the sibling wdl-dev checkouts into the gitignored
// src/content.gen.js. Run from anywhere: paths resolve relative to this file.
//
//   node scripts/build-content.mjs [--repos-dir <dir>]

import { execFileSync } from "node:child_process";
import { readFile, readdir, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createRenderer, mapOutsideCode, mapProse, rewriteMarkdownLinks } from "./markdown.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
// Both spellings: `--repos-dir <dir>` and `--repos-dir=<dir>`.
const inlineArg = process.argv.find((a) => a.startsWith("--repos-dir="));
const flagIdx = process.argv.indexOf("--repos-dir");
const reposArg = inlineArg
  ? inlineArg.slice("--repos-dir=".length)
  : flagIdx > -1
    ? process.argv[flagIdx + 1]
    : null;
const REPOS_DIR = reposArg ? path.resolve(reposArg) : path.resolve(ROOT, "..");

const exists = (p) => access(p).then(() => true, () => false);

const ORG = "https://github.com/wdl-dev";

// ---- where a repo's docs came from ----
// Asked of the checkout rather than passed in by CI, so the version a page
// claims is the one it was actually built from: a wrong `ref` shows up on the
// page instead of being papered over.

const gitIn = (repo, args) => {
  try {
    return execFileSync("git", ["-C", path.join(REPOS_DIR, repo), ...args], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
};

// Four repos, one answer each, asked once — every page would otherwise spawn
// its own git.
const refCache = new Map();

function refFor(repo) {
  if (refCache.has(repo)) return refCache.get(repo);
  const tag = gitIn(repo, ["describe", "--tags", "--exact-match", "HEAD"]);
  const named = tag || gitIn(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  // "HEAD" means detached with no tag on it; the sha is all there is to say.
  const ref = (named === "HEAD" ? gitIn(repo, ["rev-parse", "--short", "HEAD"]) : named) || "main";
  const resolved = {
    ref,
    refUrl: tag ? `${ORG}/${repo}/releases/tag/${ref}` : `${ORG}/${repo}/tree/${ref}`,
    date: gitIn(repo, ["log", "-1", "--format=%cs", "HEAD"]) || null,
  };
  refCache.set(repo, resolved);
  return resolved;
}

// ---- what to publish ----
// Curated order, because a docs site is a reading order and readdir is not one.
// reportUnlisted below names anything upstream that these lists miss.

/** Ordered top-level wdl docs; modules are discovered below. */
const WDL_TOP = [
  "architecture", "security", "compatibility", "testing", "protocol-contracts",
  "redis-key-layout", "source-map", "project-standards", "workerd-js-standards",
  "rust-sidecar-standards", "contributing",
];

/** cli topic order (README/GUIDE handled separately). */
const CLI_TOPICS = [
  "deploy", "assets", "kv", "d1", "r2", "queues", "cron-triggers",
  "durable-objects", "workflows", "secrets", "token", "env-overrides",
];

// ---- reading a source doc ----
// Title and description come from the markdown itself, so both work on prose
// only: a heading or paragraph inside a fence is a code sample, not the page's.

const proseOf = (md) => {
  const parts = [];
  mapProse(md, (text) => { parts.push(text); return text; });
  return parts.join("\n");
};

// A title is plain text everywhere but the rendered <h1> — tab, OG card,
// sidebar, JSON-LD — so inline markdown is unwrapped once, here.
export const plainText = (s) =>
  s
    // Images before links, or the inner image of a badge — [![alt](img)](to) —
    // leaves its own brackets behind.
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .trim();

export const titleOf = (md, fallback) => {
  const h1 = proseOf(md).match(/^#\s+(.+?)\s*$/m)?.[1];
  return h1 ? plainText(h1) : fallback;
};

// A bullet needs a space after its marker, or a paragraph opening with
// **bold** would read as a list item.
const STRUCTURAL = /^\s*(#|[-*+]\s|[>|]|\d+[.)]\s)/;

/** The first prose paragraph substantial enough to describe the page. */
export function summaryOf(md, limit = 155) {
  const lines = proseOf(md).split("\n");
  const paragraphs = [];
  let current = [];
  for (const line of lines.slice(lines.findIndex((l) => /^#\s+/.test(l)) + 1)) {
    if (line.trim() && !STRUCTURAL.test(line)) { current.push(line.trim()); continue; }
    if (current.length) paragraphs.push(current.join(" "));
    current = [];
  }
  if (current.length) paragraphs.push(current.join(" "));

  // Length is the filter: a language switcher such as "English | 中文" is
  // prose by every structural test but describes nothing.
  const text = paragraphs
    .map((p) => plainText(p).replace(/\s+/g, " "))
    .find((t) => t.length >= 40) ?? "";
  if (text.length <= limit) return text;
  return `${text.slice(0, text.lastIndexOf(" ", limit) + 1 || limit).trim()}…`;
}

// Each can contain the other's delimiters, so whichever opens first wins: a
// code span holding <!-- is documentation that must survive.
const CODE_OR_COMMENT = /(`+)(?:[^`\n]|\n(?!\s*\n))+\1|<!--[\s\S]*?-->/g;

// Invisible on GitHub, but the renderer escapes them into visible text.
export const stripHtmlComments = (md) =>
  mapProse(md, (run) => run.replace(CODE_OR_COMMENT, (hit) => (hit.startsWith("<!--") ? "" : hit)));

// A heuristic for the warning below, not a gate: <ns> and <machine-code> are
// placeholders meant to render exactly as written.
const HTML_TAG = [
  "a", "abbr", "b", "blockquote", "br", "center", "code", "details", "div", "em",
  "figcaption", "figure", "font", "h[1-6]", "hr", "i", "iframe", "img", "kbd",
  "li", "ol", "p", "picture", "pre", "s", "samp", "script", "section", "small",
  "source", "span", "strong", "style", "sub", "summary", "sup", "table", "tbody",
  "td", "th", "thead", "tr", "u", "ul", "video",
].join("|");
const TAG_RE = new RegExp(`</?(?:${HTML_TAG})(?:\\s[^<>\\n]*)?/?>|<!--`, "gi");

function rawHtmlFindings(md) {
  const hits = [];
  // Per prose run, never joined: concatenating the text on either side of a
  // fence lets two lone backticks pair into a span that hides real markup.
  mapProse(md, (run) => {
    mapOutsideCode(run, (part) => {
      for (const m of part.matchAll(TAG_RE)) hits.push(m[0]);
      return part;
    });
    return run;
  });
  return hits;
}

// Not documentation. src/ is the surprising one: markdown under it is program
// data, such as an embedded prompt.
const NOT_DOCS = /(^|\/)(\.deploy-dist|\.git|\.claude|node_modules|licenses|examples|test-workers|src)(\/|$)/;
// Repository furniture rather than pages of a docs site.
const FURNITURE = new Set([
  "README", "CHANGELOG", "LICENSE", "NOTICE", "SECURITY", "CONTRIBUTING",
  "AUTHORS", "CODE_OF_CONDUCT", "THIRD_PARTY_NOTICES", "AGENTS", "CLAUDE",
]);

/** Every markdown file under `dir`, relative to it. Pruned as it descends: a
 *  plain recursive readdir walks into node_modules and costs seconds. */
async function walk(dir, base = "") {
  const found = [];
  for (const entry of await readdir(path.join(dir, base), { withFileTypes: true }).catch(() => [])) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (NOT_DOCS.test(rel)) continue;
    if (entry.isDirectory()) found.push(...await walk(dir, rel));
    else if (entry.name.endsWith(".md") && !/\.zh\.md$|-zh\.md$/.test(entry.name)) found.push(rel);
  }
  return found;
}

/** Name source docs no list picks up — otherwise a doc added upstream never
 *  appears here and is never missed. */
async function reportUnlisted(pages) {
  const taken = new Set(pages.map((p) => `${p.repo}:${p.path}`));
  const strays = [];
  for (const repo of [...new Set(pages.map((p) => p.repo))]) {
    for (const file of await walk(path.join(REPOS_DIR, repo))) {
      if (FURNITURE.has(path.basename(file, ".md"))) continue;
      if (!taken.has(`${repo}:${file}`)) strays.push(`${repo}/${file}`);
    }
  }
  if (strays.length) {
    console.warn(`note: ${strays.length} source doc(s) not listed in build-content, so not published:`);
    for (const s of strays) console.warn(`  ${s}`);
  }
}

async function loadPair(repo, enPath, zhPath) {
  const en = stripHtmlComments(await readFile(path.join(REPOS_DIR, repo, enPath), "utf8"));
  let zh = null;
  if (zhPath && (await exists(path.join(REPOS_DIR, repo, zhPath)))) {
    zh = stripHtmlComments(await readFile(path.join(REPOS_DIR, repo, zhPath), "utf8"));
  }
  return { en, zh };
}

// ---- link resolution ----
// Every page is known by the time this runs, so a cross-doc link becomes a site
// route here rather than a guess at request time.

const SITE_ORIGIN = "https://wdl.md";
const pageUrl = (slug, lang) => `${SITE_ORIGIN}${lang === "zh" ? "/zh" : ""}/${slug}`;

export function makeIndex(pages) {
  const bySource = new Map();
  // Carried on the pages rather than looked up here: the resolver must be a
  // function of what it is handed, not of the checkout it happens to run beside.
  const refs = new Map(pages.filter((p) => p.ref).map((p) => [p.repo, p.ref]));
  for (const p of pages) {
    bySource.set(`${p.repo}:${p.path}`, { slug: p.slug, zh: false, hasZh: Boolean(p.zhSource) });
    if (p.zhPath) bySource.set(`${p.repo}:${p.zhPath}`, { slug: p.slug, zh: true, hasZh: true });
  }
  return { bySource, refs, repos: new Set(pages.map((p) => p.repo)) };
}

/**
 * Resolve a relative markdown link against the aggregated corpus. Anything not
 * aggregated points at the file on GitHub instead of 404ing; `absolute` gives
 * the agent copy full `https://wdl.md/…​.md` URLs instead of site routes.
 */
export function makeResolveLink({ bySource, repos, refs }, page, lang, absolute) {
  // Resolve against the file being rendered: a zh doc's relative links are
  // relative to the zh source, not to its English sibling.
  const from = (lang === "zh" && page.zhPath) || page.path;
  return (href) => {
    // Split on the first # only — the rest, extra hashes included, is fragment.
    const cut = href.indexOf("#");
    const target = cut === -1 ? href : href.slice(0, cut);
    const frag = cut === -1 ? "" : href.slice(cut);
    if (!target) return frag || "#";
    // The base carries the repo name, so a `../..` that climbs past the repo
    // root lands on another repo's segment instead of silently staying here.
    const resolvedUrl = new URL(target, `file:///${page.repo}/${from}`);
    const query = resolvedUrl.search;
    const full = resolvedUrl.pathname.replace(/^\/+/, "");
    const [head, ...rest] = full.split("/");
    const [repo, filePath] = repos.has(head) && rest.length ? [head, rest.join("/")] : [page.repo, full];

    const hit = bySource.get(`${repo}:${filePath}`);
    if (!hit) return `${ORG}/${repo}/blob/${refs.get(repo) ?? "main"}/${filePath}${query}${frag}`;
    // Reading in Chinese keeps you in Chinese, and only where that page has a
    // Chinese variant. The exception is a link to this same page's English
    // source: that is the doc's own language switcher ("[English](./token.md) |
    // 中文") and must not lead back to itself.
    const stay = lang === "zh" && hit.slug !== page.slug;
    const zhLang = (hit.zh || stay) && hit.hasZh ? "zh" : "en";
    return absolute
      ? `${pageUrl(hit.slug, zhLang)}.md${query}${frag}`
      : `${pageUrl(hit.slug, zhLang).slice(SITE_ORIGIN.length)}${query}${frag}`;
  };
}

// ---- the build ----

export const yamlStr = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** The complete text/markdown document an agent receives for one page. */
function agentMarkdown(index, page, lang, source, title, sourcePath) {
  const front = [
    "---",
    `title: ${yamlStr(title)}`,
    `source: ${ORG}/${page.repo}/blob/${page.ref}/${sourcePath}`,
    `ref: ${yamlStr(page.ref)}`,
    `canonical: ${pageUrl(page.slug, lang)}`,
    "---",
  ].join("\n");
  const body = rewriteMarkdownLinks(source, makeResolveLink(index, page, lang, true));
  return `${front}\n\n${body}${body.endsWith("\n") ? "" : "\n"}`;
}

async function main() {
  for (const repo of ["wdl", "cli", "aws-sigv4", "chat"]) {
    if (!(await exists(path.join(REPOS_DIR, repo)))) {
      console.error(`source repo '${repo}' not found at ${path.join(REPOS_DIR, repo)}\n` +
        "clone the wdl-dev repos next to this one, or pass --repos-dir <dir>.");
      process.exit(1);
    }
  }

  const pages = [];
  const push = async (section, slug, repo, enPath, zhPath) => {
    const { en, zh } = await loadPair(repo, enPath, zhPath);
    const { ref, refUrl, date } = refFor(repo);
    pages.push({
      slug, section, repo, ref, refUrl, date,
      path: enPath,
      zhPath: zh ? zhPath : null,
      enSource: en,
      zhSource: zh,
    });
  };

  for (const name of WDL_TOP) {
    await push("Platform", `platform/${name}`, "wdl", `docs/${name}.md`, `docs/${name}.zh.md`);
  }

  const moduleFiles = (await readdir(path.join(REPOS_DIR, "wdl", "docs", "modules")))
    .filter((f) => f.endsWith(".md") && !f.endsWith(".zh.md") && f !== "README.md")
    .sort();
  for (const f of moduleFiles) {
    const name = f.replace(/\.md$/, "");
    await push("Platform modules", `platform/modules/${name}`, "wdl",
      `docs/modules/${f}`, `docs/modules/${name}.zh.md`);
  }

  await push("CLI", "cli/guide", "cli", "GUIDE.md", "GUIDE-zh.md");
  for (const name of CLI_TOPICS) {
    await push("CLI", `cli/${name}`, "cli", `docs/${name}.md`, `docs/${name}-zh.md`);
  }

  // Running the platform, as opposed to using it. terraform has no translation
  // yet, so its zh URL falls back to English like any other untranslated page.
  await push("Operations", "ops/terraform", "wdl", "terraform/README.md", "terraform/README.zh.md");
  await push("Operations", "ops/kubernetes", "wdl",
    "deploy/kubernetes/README.md", "deploy/kubernetes/README.zh.md");

  await push("Libraries", "lib/aws-sigv4", "aws-sigv4", "README.md", null);
  await push("Apps", "apps/chat", "chat", "README.md", "README-zh.md");

  await reportUnlisted(pages);

  const findings = [];
  for (const p of pages) {
    for (const [lang, md] of [["en", p.enSource], ["zh", p.zhSource]]) {
      if (!md) continue;
      for (const tag of rawHtmlFindings(md)) findings.push(`  ${p.slug} (${lang}): ${tag}`);
    }
  }
  // Reported, not fatal. The renderer escapes raw HTML, so the worst case is a
  // page that reads oddly — and the corpus comes from four repos this one does
  // not control, where a hard failure would stop the site refreshing at all.
  if (findings.length) {
    console.warn("note: raw HTML outside code — these will show as literal text:");
    for (const f of findings) console.warn(f);
  }

  // Render once, here. Each language variant becomes the finished article HTML
  // and the finished markdown document the worker hands out verbatim.
  const index = makeIndex(pages);
  const rendered = pages.map((p) => {
    const one = (lang, source, sourcePath) => {
      const title = titleOf(source, p.slug.split("/").pop());
      return {
        path: sourcePath,
        title,
        summary: summaryOf(source),
        html: createRenderer(makeResolveLink(index, p, lang, false))(source),
        markdown: agentMarkdown(index, p, lang, source, title, sourcePath),
      };
    };
    return {
      slug: p.slug,
      section: p.section,
      repo: p.repo,
      ref: p.ref,
      refUrl: p.refUrl,
      date: p.date,
      en: one("en", p.enSource, p.path),
      zh: p.zhSource ? one("zh", p.zhSource, p.zhPath) : null,
    };
  });

  const body = `// @generated by scripts/build-content.mjs — DO NOT EDIT.
// Source of truth is the markdown in the wdl-dev repos; re-run the script to
// refresh. Pages arrive rendered: the worker serves \`html\` and \`markdown\`
// as they are and never parses markdown at request time.
export const PAGES = ${JSON.stringify(rendered, null, 1)};
`;
  const outPath = path.join(ROOT, "src", "content.gen.js");
  await writeFile(outPath, body);

  const bySection = {};
  let source = 0;
  let out = 0;
  for (const p of rendered) {
    bySection[p.section] = (bySection[p.section] ?? 0) + 1;
    for (const v of [p.en, p.zh]) {
      if (!v) continue;
      source += v.markdown.length;
      out += v.html.length + v.markdown.length;
    }
  }
  console.log(`wrote ${path.relative(process.cwd(), outPath)}`);
  for (const [s, n] of Object.entries(bySection)) console.log(`  ${s}: ${n} pages`);
  console.log(`  ${rendered.length} pages, ${(source / 1024).toFixed(0)} KB markdown → ` +
    `${(out / 1024).toFixed(0)} KB rendered, ${rendered.filter((p) => p.zh).length} with zh variant`);
}

// Importing this module must not run a build, so the run is gated on being
// the entry point — the pure helpers above are what the tests reach for.
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
