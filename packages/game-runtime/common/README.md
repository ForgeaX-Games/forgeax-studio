# @forgeax/game-runtime-common

Shared Runtime verification, cache, launch, environment, port, manifest, and Engine SDK APIs used by ForgeaX platform Runtime packages.

`@forgeax/game` depends on this package directly so declarations, both game templates,
Engine source, and every Engine authoring skill remain available even when no native
Runtime matches the host. Platform packages also create a distribution with explicit
package roots; this package never searches for a neighboring Game or Studio checkout.
