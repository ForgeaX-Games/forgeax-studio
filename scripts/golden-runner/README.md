# Golden runner

`runner.ts` executes deterministic L4a probes and model-driven L4b cases.

## L4b ownership

An L4b run owns the complete test envelope:

1. Reserve a loopback port and start `packages/server/src/main.ts` with
   `FORGEAX_KERNEL=kernel` and `FORGEAX_KERNEL_IMPL=<case.kernel.providerId>`.
2. Wait for `/api/health`; archive the secret-free startup manifest and capped,
   redacted server logs.
3. Let the product create and scaffold the session agent.
4. Atomically replace `agent.json::models.model` with one string, then read it back.
5. Run the real `forge run --json` client with an explicit environment allowlist.
   CLI stdout, stderr, and case evidence use the same redactor. Do not pass
   `--provider`: that option does not exist and its value would become user
   prompt text.
6. Assert `providerId` on every provider-attributable wire event. Missing attribution,
   a mismatch, or zero attributable events fails the case.
7. Capture the real CLI request `callId` through a one-turn loopback proxy. Inject a
   random nonce into the CLI prompt and require the fresh session's ledger
   `user_input` to contain that nonce. The requested-model proof comes from the
   associated `hook:assistantMessage.payload.model`, never from configuration
   readback. Configuration is read again only to detect scaffold overwrite races.
8. Delete runner-owned artifacts, then stop the dedicated server and archive its logs.

The current host ledger does not persist the top-level turn `callId`, so the report
states the correlation method explicitly as
`runner-injected-nonce+isolated-ledger-delta`. The runner uses a fresh session and
accepts exactly one nonce-bearing `user_input` and one assistant row in that delta;
ambiguity fails. CallId-level ledger correlation remains an M3 upgrade after the
ledger persists `callId`.

## Model verification limit

M2 verifies the host-composed requested model only. Every L4b report must retain:

> Model verification covers the host-composed requested model only; it does not prove
> the kernel or backend accepted or executed that model.

Accordingly, `modelExecutedVerified` is always `WAIVED` and `bl2Verdict` is always
`PARTIAL` in M2. Top-level `runCompleted` records only executable completion; there is
no top-level `pass` field that can be mistaken for a BL2 verdict. M3 closes the gap
with `ActionDispatchEventV1` carrying separate `requestedModel` and `effectiveModel`
fields.

## Commands

```bash
bun run test:golden-runner
bun scripts/golden-runner/runner.ts --case role-slice --mode l4b --report /tmp/role-slice.json
```

L4b requires the runner-owned server and requires requested port `0`; the selected
loopback port is recorded in the startup manifest. `manageServer=false` and a fixed
`--server-port` are rejected.
