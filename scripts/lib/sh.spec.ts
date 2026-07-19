import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { run } from "./sh";

const originalTrace = process.env.FORGEAX_COMMAND_TRACE;
const originalToken = process.env.GH_TOKEN;

afterEach(() => {
  if (originalTrace === undefined) delete process.env.FORGEAX_COMMAND_TRACE;
  else process.env.FORGEAX_COMMAND_TRACE = originalTrace;
  if (originalToken === undefined) delete process.env.GH_TOKEN;
  else process.env.GH_TOKEN = originalToken;
});

describe("run command tracing", () => {
  test("prints command, cwd, duration, and non-zero exit directly to stdout", () => {
    process.env.FORGEAX_COMMAND_TRACE = "1";
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...args) => {
      lines.push(args.join(" "));
    });

    const ok = run(process.execPath, ["-e", "process.exit(7)"], { cwd: process.cwd() });
    log.mockRestore();

    expect(ok).toBeFalse();
    expect(lines.some((line) => line.includes("[command:start]") && line.includes(process.execPath))).toBeTrue();
    expect(lines.some((line) => line.includes(`cwd=${process.cwd()}`))).toBeTrue();
    expect(lines.some((line) => line.includes("[command:end]") && line.includes("exit=7"))).toBeTrue();
    expect(lines.some((line) => /duration_ms=\d+/.test(line))).toBeTrue();
  });

  test("redacts credential values if a future command passes one as an argument", () => {
    process.env.FORGEAX_COMMAND_TRACE = "1";
    process.env.GH_TOKEN = "trace-secret-token";
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...args) => {
      lines.push(args.join(" "));
    });

    run(process.execPath, ["-e", "process.exit(0)", "trace-secret-token"]);
    log.mockRestore();

    expect(lines.join("\n")).not.toContain("trace-secret-token");
    expect(lines.join("\n")).toContain("***");
  });
});
