# wdl.md

The documentation site for [WDL](https://wdl.dev) — one domain that aggregates
the markdown already maintained across the wdl-dev repositories and renders it
server-side. `.md` is both the TLD and the point.

Like [site](https://github.com/wdl-dev/site), this is a single WDL Worker
scaffolded in the house style: zero runtime dependencies, server-rendered HTML,
static assets through ASSETS, deployed with `wdl deploy`.

## What it serves

- `/` — section index (Platform, Platform modules, Operations, CLI, Libraries,
  Apps).
- `/<section>/<page>` — a doc page, e.g. `/platform/architecture`, `/cli/guide`.
- `/zh/<section>/<page>` — the Chinese variant where the source repo maintains
  one (`.zh.md` / `-zh.md`); pages without a variant redirect to English.
- `/llms.txt` — machine-readable index for AI tooling; `/robots.txt` and
  `/sitemap.xml` (every page, both languages) for crawlers.
- SEO plumbing matching the site worker: a per-page description and
  `rel=canonical`/`og:url`, an `og:image` link card, `hreflang` alternates on
  bilingual pages, Organization/WebSite JSON-LD plus a per-doc TechArticle
  node, and a 301 from every non-canonical host to `wdl.md` (the health
  endpoint keeps answering platform probes, `noindex`; loopback is left alone
  so a local run stays reachable). Each `.md` twin sends a `Link: rel=canonical`
  header pointing at its HTML page.
- Reader UI: an EN/中文 toggle per page, a light/dark toggle (follows the
  system until first use), and a collapsible sidebar that becomes a drawer on
  phones — with a scrim, a scroll lock, Escape to close, and the content behind
  it `inert`. Preferences persist in localStorage through ~50 lines of inline
  script — the only JavaScript on the site — restored before first paint, so
  nothing flashes. Without JavaScript the nav simply stacks above the article.
- Markdown for agents: every page also serves its markdown source — request it
  with `Accept: text/markdown` or a `.md` suffix (`/cli/guide.md`; `/index.md`
  for the section index). Same contract as Cloudflare's [Markdown for
  Agents](https://developers.cloudflare.com/fundamentals/reference/markdown-for-agents/)
  (`text/markdown` content type, `Vary: Accept`, `x-markdown-tokens` /
  `x-original-tokens`, `content-signal`), implemented in the worker — and
  lossless, since markdown *is* the source here. Relative links are rewritten
  to absolute site/GitHub URLs; a frontmatter block carries title, source file,
  and canonical URL.
- Short links for CLI error messages and chat: `/init`, `/deploy`, `/d1`,
  `/r2`, `/kv`, `/secrets`, `/guide`, `/architecture`, `/security`. They compose
  with the `.md` suffix (`/deploy.md`) and preserve any query string.

## How content flows

```
wdl/docs/**  wdl/terraform + deploy/kubernetes  cli/GUIDE.md + cli/docs/**
aws-sigv4/README  chat/README
        │
        ▼  scripts/build-content.mjs  (every deploy runs it; locally it reads sibling checkouts)
        │    aggregates, then renders through scripts/markdown.mjs — markdown-it
        │    with html:false — resolving every cross-doc link against the corpus
src/content.gen.js   — generated and gitignored; it never enters the repo
        │    each page carries finished `html` and a finished `markdown` document
        ▼
src/index.js   — routing and the page shell; it never parses markdown
```

The corpus is fixed at build time, so it is rendered there once rather than on
every request. The worker ships without the renderer and answers a doc page in
well under a millisecond.

Relative links between docs are rewritten to site routes when the target is
aggregated, and to the file on GitHub when it is not — no dead links either way.

Rendering is CommonMark by way of markdown-it, run with `html: false` so raw
HTML in a source doc is escaped rather than passed through — a doc can never
inject markup into the page. Four renderer rules shape the output this site
needs: heading anchors, resolved links, images rendered as links (the site
loads no third-party assets), and the scrollable table wrapper. The build also
strips HTML comments (invisible on GitHub, literal text here) and reports any
raw HTML it still finds. It reports rather than fails: the corpus comes from
four repositories this one does not control, and a page that reads oddly for a
day beats a deploy pipeline any of them can stop.

## Develop

```bash
npm install               # dev-only deps (wrangler for dry-run, wdl for deploy)
npm run build:content     # generate src/content.gen.js from ../wdl, ../cli, ...
npm test                  # renderer + corpus tests (needs build:content first)
npm run dry-run           # wrangler bundle check (needs build:content first)
```

`public/` holds the finished brand assets — favicon, logo and the 1200×630
`og.png` link card — copied or composed from the mark in
[site](https://github.com/wdl-dev/site)'s `brand/`. They change about never, so
this repo carries the outputs rather than a generator and a `sharp` dependency.

`build:content` walks every source repo and warns about any markdown no list
publishes, so a doc added upstream — in a directory nobody thought to watch —
does not go missing silently. Build output, dependencies, licence notices,
examples and source trees are not counted as documentation.

`build-content` expects the sibling checkouts one directory up
(`../wdl`, `../cli`, `../aws-sigv4`, `../chat`); pass `--repos-dir <dir>` to
point elsewhere.

## Deploy

Deploys are CI-driven: `.github/workflows/deploy.yml` runs on every push to
main, daily, and on manual dispatch — it clones the source repos, regenerates
`src/content.gen.js`, runs the tests, and deploys. The corpus never enters git, so
freshness is simply the newest run, and a manual dispatch is the immediate
"deploy now" button. The workflow needs the `WDL_DEPLOY_TOKEN` repo secret — a
deploy token scoped to the `site` namespace, not an operator token, since
deploying and pruning this one worker is all it is ever used for — passed to the
CLI as `ADMIN_TOKEN`; the control-plane URL comes from the `CONTROL_URL` repo
variable and defaults to `api.wdl.dev`.

Each deploy creates a new immutable version and the platform retains every one,
so the workflow then runs `npm run prune` (`scripts/prune-versions.mjs`): it
keeps the active version plus the two behind it and deletes the rest. Without it
the daily schedule alone would leave a year of bundles standing.

A manual deploy is the same three steps:

```bash
npm run build:content && npm run deploy && npm run prune
```

The `wdl.md` host is operator-declared for the namespace — the same mechanism
that maps `wdl.dev` to the site worker — and `routes` in `wrangler.jsonc` points
it at this worker, so the deploy serves `https://wdl.md/` directly.

## Not here yet

- Content is a deploy-time snapshot, so the daily workflow bounds staleness at
  one day. A `repository_dispatch` from the source repos would close that gap
  and is the obvious next step.
- No search. `/llms.txt` and find-in-page are the answer for now, and the corpus
  is around the size where that stops being enough.
- Markdown is CommonMark plus tables and strikethrough. Footnotes, definition
  lists and the like would each need a markdown-it plugin.
