export type BufferedCommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

export function positiveConcurrency(
  value: string | undefined,
  fallback: number,
  label: string,
): number {
  const parsed = value === undefined
    ? fallback
    : /^\d+$/.test(value)
      ? Number.parseInt(value, 10)
      : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

export async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('concurrency must be a positive integer');
  }

  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        results[index] = await worker(items[index]!, index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export function runCommandBuffered(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<BufferedCommandResult> {
  return (async () => {
    try {
      const child = Bun.spawn([command, ...args], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [status, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return {
        status,
        stdout,
        stderr,
      };
    } catch (error) {
      return {
        status: null,
        stdout: '',
        stderr: '',
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  })();
}
