# @forgeax/game-runtime

Universal platform selector for ForgeaX Game Runtime. It loads exactly one optional native package for the current machine; each native package depends on the shared common implementation.

Supported targets are macOS arm64, Windows x64, and Linux glibc x64. Installation with optional dependencies disabled produces an explicit diagnostic at import time.
