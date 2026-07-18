See AGENTS.md for how to work on a WDL Worker.

Two things are specific to this repo and override the generic deploy steps
there: `src/content.gen.js` is generated and gitignored, so a fresh clone must
run `npm run build:content` before `npm test`, `npm run dry-run` or
`npm run deploy` will work; and the corpus comes from the sibling checkouts
`../wdl`, `../cli`, `../aws-sigv4`, `../chat` (or `--repos-dir <dir>`).
