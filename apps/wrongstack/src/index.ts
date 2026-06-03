// @deprecated — kept only to document the re-export. The bin entry for
// this package is `./src/index.js` (see package.json `bin` field) and
// this .ts file was a byte-identical duplicate of it. The apps/wrongstack
// package is intentionally build-less (`build: "echo 'no build'"`) — it
// just re-exports @wrongstack/cli's `main`. Delete this file in a
// follow-up commit if the maintainers are comfortable dropping the TS
// source for a two-line bin shim. See H11 in the 2026-06-03 audit.
export {};
