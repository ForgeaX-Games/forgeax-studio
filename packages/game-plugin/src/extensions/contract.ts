export interface ExtensionContext {
  projectRoot: string;
  stateDir: string;
  packageVersion: string;
}

/** check returns non-secret configuration; the host owns publication and removal. */
export interface ExtensionCLI {
  check(context: ExtensionContext, args: readonly string[]): Promise<unknown>;
  run(context: ExtensionContext, args: readonly string[]): Promise<unknown>;
}
