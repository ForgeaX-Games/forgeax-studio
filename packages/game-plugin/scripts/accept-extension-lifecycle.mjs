import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const [cliInput, gameInput] = process.argv.slice(2);
if (!cliInput || !gameInput) throw new Error('usage: node scripts/accept-extension-lifecycle.mjs <installed-cli> <initialized-test-game>');
const cli = resolve(cliInput), game = resolve(gameInput);
assert(cli.includes('/node_modules/@forgeax/game/dist/'));
const extension = resolve(dirname(cli), '../assets/extensions/lifecycle-fixture');
assert(!existsSync(extension), 'do not overwrite a pre-existing extension');
const call = (args, expected = 0, cwd = game, env = process.env) => {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: 'utf8', timeout: 120000 });
  assert.equal(result.status, expected, `${args.join(' ')}: ${result.stdout} ${result.stderr}`);
  return result.stdout;
};
try {
  mkdirSync(resolve(extension, 'skills/lifecycle-fixture'), { recursive: true });
  writeFileSync(resolve(extension, 'extension.json'), JSON.stringify({ schemaVersion: 1, id: 'lifecycle-fixture', version: '1.0.0', skills: ['skills/lifecycle-fixture'], cli: 'cli.mjs' }));
  writeFileSync(resolve(extension, 'cli.mjs'), 'export async function check(c,a){if(a.includes("--fail"))throw new Error("fixture_check_failed");return {ready:true}} export async function run(c,a){return {operation:a[0],project:c.projectRoot}}');
  writeFileSync(resolve(extension, 'skills/lifecycle-fixture/SKILL.md'), '# Fixture\n{{CLI}} echo --json\n');
  const skill = resolve(game, '.trae/skills/lifecycle-fixture/SKILL.md');
  const rejected = JSON.parse(call(['lifecycle-fixture', 'enable', '--ide', 'trae', '--local', '--fail', '--json'], 1));
  assert.equal(rejected.ok, false); assert(!existsSync(skill));
  call(['lifecycle-fixture', 'enable', '--ide', 'trae', '--local', '--json']);
  assert(readFileSync(skill, 'utf8').includes(cli));
  const executed = JSON.parse(call(['lifecycle-fixture', 'echo', '--json']));
  assert.equal(executed.value.operation, 'echo');
  writeFileSync(skill, 'user-edited instruction');
  const disabled = JSON.parse(call(['lifecycle-fixture', 'disable', '--json']));
  assert(!existsSync(skill));
  assert.equal(readFileSync(disabled.value.backups[0], 'utf8'), 'user-edited instruction');
  assert.equal(JSON.parse(call(['lifecycle-fixture', 'echo', '--json'], 1)).error.code, 'extension_not_enabled');
  call(['lifecycle-fixture', 'disable', '--json']);
  call(['lifecycle-fixture', 'enable', '--ide', 'trae', '--local', '--json']);
  call(['uninstall', '--ide', 'trae']);
  assert(!existsSync(skill));
  assert(!existsSync(resolve(game, '.forgeax/extensions/lifecycle-fixture')));
  assert(!existsSync(resolve(game, '.forgeax/extensions/asset3d')));
  assert(!existsSync(resolve(game, '.zcode/skills/art-3d-asset-library/SKILL.md')));
  // Exercise machine-wide cleanup only against an isolated project registry.
  const env = { ...process.env, FORGEAX_USER_STATE_DIR: resolve(game, '.acceptance-user-state') };
  const second = resolve(game, '.acceptance-second');
  mkdirSync(second, { recursive: true });
  for (const file of ['forge.json', 'package.json']) writeFileSync(resolve(second, file), readFileSync(resolve(game, file)));
  call(['lifecycle-fixture', 'enable', '--ide', 'trae', '--local', '--json'], 0, game, env);
  call(['lifecycle-fixture', 'enable', '--ide', 'trae', '--local', '--json'], 0, second, env);
  call(['uninstall', '--all-projects', '--ide', 'trae'], 0, game, env);
  assert(!existsSync(skill));
  assert(!existsSync(resolve(second, '.trae/skills/lifecycle-fixture/SKILL.md')));
  assert(!existsSync(resolve(env.FORGEAX_USER_STATE_DIR, 'extension-projects.json')));
  console.log('PASS: directory discovery, check failure, Skill launch, CLI routing, edit backup, disable, repeat disable, re-enable and host uninstall cascade.');
  console.log('PASS: uninstall --all-projects cleans both registered fixture projects.');
} finally {
  rmSync(extension, { recursive: true, force: true });
}
