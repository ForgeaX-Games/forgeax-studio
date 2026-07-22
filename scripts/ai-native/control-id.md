# `control_id` stable identity

`control_id` is a source identity, not a line identity:

```text
ctl_ + sha256(repo + repo-relative path + component/function + event + structure fingerprint)[0:24]
```

The structure fingerprint is the first 20 hex characters of a canonical JSON
hash containing:

- JSX/native element type (or the listener target for source-level controls);
- static `id`, `name`, `role`, `type`, `title`, `href`, `to`, `className`, `value`,
  `aria-*`, and `data-*` attributes (dynamic expressions are ignored);
- normalized direct static text, capped at 160 characters;
- the zero-based ordinal among otherwise identical element/event structures in
  the same component. The ordinal is only a collision fallback for sibling
  controls that have no distinct stable label/test id/text.

`postmessage-handler` controls use one row per statement-level, non-prop call
inside `addEventListener('message', handler)`. Their event is
`message:<branch>`, where `<branch>` is the nearest static equality/switch
discriminator (for example `FORGEAX_COMPOSER_INSERT`) or a preceding static
inequality guard that exits the handler (for example `fx-pointer-capture`). If
neither is available, the direct call name is a conservative fallback. The
fingerprint attributes are the listener target and that branch tag. Calls
forwarded to `onX` props are not duplicated here because their concrete
custom-component callback usages are collected separately.

Message exclusions are call-scoped as well as file/event-scoped. Thus an
audited transport call can be excluded without hiding a new direct effect added
to another branch of the same listener.

`subscription-handler` controls represent source-level custom pub/sub calls in
two separately audited families: `<receiver>.onXxx(callback)` and exact
lowercase property methods named `<receiver>.on(...)`, `.once(...)`, or
`.subscribe(...)`. No other callback-taking method is inferred. Their event is
the method name; receiver, method, and a statically known first-argument topic
are stable fingerprint attributes. Callback bodies use the same effect
propagation as JSX and `addEventListener` handlers. Audited React lifecycle,
Promise, and transport/stream families live in the explicit
`subscription_rules` section of `exclusions.json`; lowercase-family exclusions
are file/receiver/method scoped (and topic scoped where needed), every remaining
match is collected, and unresolved effects enter the manual-classification
pool.

Line number, whitespace, formatting, comments, and handler implementation are
never fingerprint inputs for JSX/native controls. Replacing `setFoo()` with a
command/action dispatch therefore keeps their id stable. For a postMessage
branch with no static wire discriminator, changing the fallback call name
intentionally changes its raw id because that call is the only available source
identity; record such a migration in `alias-map.json` when the operation itself
is unchanged.

Moving a file or renaming its component intentionally produces a new raw id.
Such changes must add an auditable `{old_control_id,new_control_id,reason}` row
to `alias-map.json`. Old ids stay in that file permanently; consumers follow
the alias chain with `resolveAlias`. Cycles, duplicate endpoints, malformed ids,
and no-op aliases fail validation.
