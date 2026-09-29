import { afterEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { CLIP_MAP } from './clip-map'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'guishimen-import-'))
  temporaryRoots.push(root)
  const checkout = join(root, 'relocated checkout')
  const scripts = join(checkout, 'scripts')
  const cwd = join(root, 'other working directory')
  mkdirSync(scripts, { recursive: true })
  mkdirSync(cwd)
  for (const name of ['import-guishimen-assets.ts', 'video-asset-manifest.ts']) {
    copyFileSync(resolve(import.meta.dir, '..', name), join(scripts, name))
  }
  cpSync(import.meta.dir, join(scripts, 'guishimen'), { recursive: true })
  const script = join(scripts, 'import-guishimen-assets.ts')
  const game = join(checkout, '.forgeax/games/guishimen')
  const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' })
  return { checkout, cwd, game, run }
}

test('requires an explicit source directory before writing game files', () => {
  const { game, run } = fixture()
  const result = run()
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('<source-directory>')
  expect(existsSync(game)).toBe(false)
})

test('imports relative sources into its own checkout from another working directory', () => {
  const { checkout, cwd, game, run } = fixture()
  const source = join(cwd, 'source videos')
  mkdirSync(source)
  for (const clip of CLIP_MAP) writeFileSync(join(source, clip.src), `fixture: ${clip.src}`)
  const battle = join(checkout, '.forgeax/games/wuxia-combat/video-game')
  mkdirSync(battle, { recursive: true })
  writeFileSync(join(battle, 'scenarios.json'), JSON.stringify({
    items: [{ id: 'demo-001', scenario: { rootSceneId: 'a_my', scenes: { a_my: {} } } }],
  }))

  const result = run('source videos')
  expect(result.status).toBe(0)
  expect(result.stderr).toBe('')
  const manifest = JSON.parse(readFileSync(join(game, 'assets/manifest.json'), 'utf8'))
  expect(manifest.version).toBe(2)
  expect(manifest.assets).toHaveLength(CLIP_MAP.length)
  for (const clip of CLIP_MAP) {
    expect(readFileSync(join(game, 'assets/blobs', clip.blob), 'utf8')).toBe(`fixture: ${clip.src}`)
  }
  expect(JSON.parse(readFileSync(join(game, 'forge.json'), 'utf8')).name).toBe('guishimen')
  expect(JSON.parse(readFileSync(join(game, 'video-game/scenarios.json'), 'utf8')).activeId).toBe('guishimen-main')
  expect(existsSync(join(cwd, '.forgeax'))).toBe(false)
})
