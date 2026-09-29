# EA native Pack acceptance — 2026-09-16

## Verdict

PASS for the bounded macOS asset-use path: real EA candidate discovery, explicit
Agent selection, native Pack download, transactional Engine import, authored game
use, visible Preview, and left/right keyboard movement. This is not a claim that
every project development gate or platform passes.

## Candidate and execution

- Plugin implementation: `9cd77d52`, followed by CLI identity documentation in `c1083aa3`.
- Tested CLI SHA-256: `42b7627a7876ae218440c59c3fe3a67b750527ef08bbdc38cc88894966959a51`.
- Provider: `a274238712c1dced99e4aa3148a0d15904ce2a90`.
- Engine: `0.1.26`, `f3d0db12405e168e4204e32a9cde32e0df8d87ae`.
- Local `codex1`: `gpt-5.6-luna`, reasoning effort `max`.
- Codex session: `01a0aa0b-fa0c-7fc2-a1df-56f5c9c2598a`.
- Successful transaction: `aa25b7fc-d69b-495d-a013-9115fb7a4987`.
- Query: `wooden tea counter`; selected `prop-tea-counter.zip`, ID `6aa925b81b556072c922a7c2`.

| Gate | Evidence |
|:--|:--|
| Candidate discovery | Live `list_asset_candidates` returned ten catalog identities; Agent selected the tea counter by name and purpose. |
| Native download | `search_asset` with explicit ID and `output_format: asset` returned `deliveredFormat: pack`. |
| Source closure | 39 files, 15,178,351 bytes, aggregate SHA-256 `e060b8c7f954962232e871b0bc2297af96b2c4a0166e85bf620ba93ef390e213`; all file hashes independently checked unchanged. |
| Import | Normal `asset3d commit`: succeeded 1, failed 0; Engine-owned build catalog readback. |
| Runtime identities | Scene `1073cc16-2533-53dc-a63f-cbd45527b75d`; mesh `e8f5e01e-5974-5bcb-826b-05dca2a03d21`. |
| Authored use | `forge.json.defaultScene` uses the imported scene; project Engine plugin adds camera, light, and keyboard movement. No replacement geometry. |
| Preview | Build digest `2a61d26cf3d8f8c6151311429cb662cdb9d5092bdd8c5791c91e22d5acc50715`; instance `7bd11af1-ff62-4740-80ca-f8ef157f679d`. |
| Visual/input | Maintainer opened the returned Preview in headed Chromium; tea counter, texture, worktop and kettle visible. ArrowRight moves right; reload restores baseline; ArrowLeft moves left. No runtime state injection. |

The live project is `ea-pack-selected-3vEibV/game` under the local test directory.
Sibling screenshots: `baseline.png`, `after-right.png`, `reload.png`, `after-left.png`.
The maintainer independently performed the browser observation and input checks;
these observations are not inferred from the CLI Agent's self-report.

## Limitations and initial failures

- Initial local CLI resolved an older global npm package while MCP used the new
  candidate. It rejected `primaryPack` as an unknown success field. The failed
  transaction was aborted. Installing the same candidate globally and verifying
  both executable hashes resolved the mismatch; a new real transaction passed.
- Plain project `pnpm typecheck` needs `allowImportingTsExtensions` for imported
  Pack source. `tsc --noEmit --allowImportingTsExtensions` passed. This is not a
  plain-command PASS.
- Plain project `pnpm test` discovers an upstream Skill's `legacy/scripts/workflow.test.mjs`.
  The two project-specific behavior tests passed when targeted. Full test discovery
  was not repaired or claimed green in this bounded asset acceptance.
- Clicking the canvas in the automation browser produced `app-pointer-lock-failed`
  / `WrongDocumentError`. The scene remained visible and keyboard movement worked;
  reload plus keyboard-only input also worked. Pointer-lock is not verified.
- Linux bundle was rebuilt with pinned dependency inputs; no real Linux EA search
  or browser acceptance was performed in this run.
- No npm publication, merge, commercial-license clearance, or unrestricted
  full-game acceptance is implied.
