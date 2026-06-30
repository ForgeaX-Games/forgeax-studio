/**
 * 回退点端到端(driver 层):checkpointTurn → 模拟编辑 → rewind 应真正还原 cwd 文件。
 * 走 buildHostContext(demo) + createAgentDriver,chdir 到 tmp 以隔离真实文件回退。
 */
import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildHostContext } from '../../src/cli/host-context';
import { createAgentDriver } from '../../src/tui/driver/useAgent';

const ARGS = { model: 'claude-opus-4-8', demo: true } as const;

let tmp: string;
let prevCwd: string;

beforeEach(() => {
  prevCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), 'drv-cp-'));
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(prevCwd);
  rmSync(tmp, { recursive: true, force: true });
});

async function mkDriver() {
  const host = await buildHostContext({ ...ARGS, sessionsDir: join(tmp, '.forgeax/sessions'), sessionId: 's1' });
  return createAgentDriver({ ...ARGS, sessionsDir: join(tmp, '.forgeax/sessions'), sessionId: 's1' }, host);
}

describe('driver checkpoint (real file rewind)', () => {
  test('checkpointTurn snapshots cwd; rewind reverts a later edit', async () => {
    const driver = await mkDriver();
    try {
      writeFileSync(join(tmp, 'foo.ts'), 'v1\n');
      const m1 = driver.checkpointTurn(); // 锚点:foo=v1
      expect(m1).toBeTruthy();

      // 模拟 agent 这一轮把 foo 改成 v2
      writeFileSync(join(tmp, 'foo.ts'), 'v2\n');

      // preview 应看到差异(回退到 m1 会把 v2→v1)
      const diff = driver.previewRewind(m1!);
      expect(diff?.filesChanged).toContain('foo.ts');

      const r = await driver.rewind({ msgId: m1!, hasCode: true, currentMessages: [], targetHistory: [] });
      expect(r).not.toHaveProperty('error');
      // ★ 关键断言:盘上文件真的被还原
      expect(readFileSync(join(tmp, 'foo.ts'), 'utf-8')).toBe('v1\n');
    } finally {
      await driver.dispose();
    }
  });

  test('rewind to an earlier anchor deletes files created later', async () => {
    const driver = await mkDriver();
    try {
      const m1 = driver.checkpointTurn(); // 空状态
      writeFileSync(join(tmp, 'new.ts'), 'created\n'); // 这一轮新建
      driver.checkpointTurn(); // m2(含 new.ts)

      const r = await driver.rewind({ msgId: m1!, hasCode: true, currentMessages: [], targetHistory: [] });
      expect(r).not.toHaveProperty('error');
      expect(existsSync(join(tmp, 'new.ts'))).toBe(false); // 干净还原:删掉
    } finally {
      await driver.dispose();
    }
  });

  test('cancelRewind (Redo) restores files to pre-rewind state', async () => {
    const driver = await mkDriver();
    try {
      writeFileSync(join(tmp, 'foo.ts'), 'v1\n');
      const m1 = driver.checkpointTurn();
      writeFileSync(join(tmp, 'foo.ts'), 'v2\n');

      await driver.rewind({ msgId: m1!, hasCode: true, currentMessages: [], targetHistory: [] });
      expect(readFileSync(join(tmp, 'foo.ts'), 'utf-8')).toBe('v1\n');

      const r = await driver.cancelRewind();
      expect(r).not.toHaveProperty('error');
      expect(readFileSync(join(tmp, 'foo.ts'), 'utf-8')).toBe('v2\n'); // Redo 回到回退前
    } finally {
      await driver.dispose();
    }
  });
});
