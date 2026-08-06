const COMMAND_HELP: Readonly<Record<string, string>> = {
  status: `Usage: bun fx status --repos

Show the recursive repository table: branch, ahead/behind, dirt, and pin drift.`,
  versions: `Usage: bun fx versions

Show the repository table plus each checkout's derived nearest tag.`,
  sync: `Usage: bun fx sync [--dry-run]

Fetch and fast-forward submodule branches that have upstreams. Root and detached
checkouts are left unchanged.`,
  check: `Usage: bun fx check [--all] [path...]

Run each matching repository's own gates. By default only dirty repositories are
checked; --all includes clean repositories.`,
  commit: `Usage: bun fx commit -m "message" [path...] [--push] [--dry-run] [--no-verify]

Gate and commit matching repositories leaf-first. --push pushes feature branches;
main is always refused. Parent pins must already exist on child remotes.`,
  bump: `Usage: bun fx bump <path...> [--dry-run]

Fetch and fast-forward direct submodule branches, then stage their new pins in the
root repository. Paths must be direct submodules such as packages/interface. The
target repository and every nested submodule must be clean before a pin can move.`,
};

export function repositoryCommandHelp(command: string): string | undefined {
  return COMMAND_HELP[command];
}
