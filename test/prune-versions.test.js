// Which versions a prune would delete. The deletion itself is the control
// plane's, but the choice is this repo's and it is irreversible, so the cases
// that decide it are pinned here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planPrune } from "../scripts/prune-versions.mjs";

const v = (n) => Array.from({ length: n }, (_, i) => `v${i + 1}`);

test("keeps the active version and the two behind it", () => {
  const { keep, doomed } = planPrune(v(40), "v40");
  assert.deepEqual(keep, ["v40", "v39", "v38"]);
  assert.equal(doomed.length, 37);
  assert.ok(!doomed.includes("v40"), "the live version is never deleted");
});

test("orders by version number, not as text", () => {
  // A string sort puts v10 before v9 and would keep the wrong two.
  const { keep } = planPrune(["v8", "v9", "v10", "v11"], "v11");
  assert.deepEqual(keep, ["v11", "v10", "v9"]);
});

test("a rollback leaves the active version behind the newer ones", () => {
  // Active is the oldest here; it still survives, and the two newest are the
  // rollback targets.
  const { keep, doomed } = planPrune(["v9", "v10", "v11", "v12"], "v9");
  assert.deepEqual(keep, ["v9", "v12", "v11"]);
  assert.deepEqual(doomed, ["v10"]);
});

test("nothing to delete at or below the retention floor", () => {
  assert.deepEqual(planPrune(["v41"], "v41").doomed, []);
  assert.deepEqual(planPrune(["v41", "v42", "v43"], "v43").doomed, []);
});
