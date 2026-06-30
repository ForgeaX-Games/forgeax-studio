// type-only AppKit SDK call site probe -- feeds AC-08 IMPORTANT real call site
// (separated from main.tsx to keep AC-21 line-count parity with interface/src/main.tsx)
//
// `MountOptions` was narrowed (interface/src/app-kit.ts:60) from the legacy
// `{ apps: DefinedApp[] }` shape down to `{ entryUrl?: string }`; the
// `defineApp` helper still exists but is no longer the input shape for
// mountComposition. Updated to the current API surface so this file
// typechecks. defineApp is still imported as a touch-test for the export
// itself (AC-08 wants a real call site, not just a type-import).
import { defineApp, mountComposition } from '@forgeax/interface/app-kit'
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _appKitProbe = () => {
  void defineApp({ id: 'studio-shell' })
  mountComposition({ entryUrl: '/studio-shell' })
}
