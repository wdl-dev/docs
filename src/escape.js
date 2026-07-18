// The one HTML escape used by the worker's shell and by the build-time
// renderer, so a change to it can never apply to only half the output.
const ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

export const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ENTITIES[c]);
