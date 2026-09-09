import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const DIGEST = /^[0-9a-f]{64}$/;
const REVISION = /^[0-9a-f]{40}$/;

export type VerifiedMirrorAuthorization = {
  candidateDigest: string;
  integrationRevision: string;
  intent: 'publish';
};

export function validateVerifiedMirrorAuthorization(value: VerifiedMirrorAuthorization): void {
  if (!DIGEST.test(value.candidateDigest)) throw new Error('verified candidate digest is invalid');
  if (!REVISION.test(value.integrationRevision)) throw new Error('verified integration revision is invalid');
  if (value.intent !== 'publish') throw new Error('mirror requires explicit publish intent');
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (import.meta.main) {
  try {
    const authorization: VerifiedMirrorAuthorization = {
      candidateDigest: option('candidate-digest') ?? '',
      integrationRevision: option('integration-revision') ?? '',
      intent: option('intent') as 'publish',
    };
    validateVerifiedMirrorAuthorization(authorization);
    const root = resolve(import.meta.dir, '../..');
    for (const [script, args] of [
      ['scripts/mirror/publish-multi.sh', ['push']],
      ['scripts/mirror/protect-repos.sh', []],
    ] as const) {
      const result = spawnSync('bash', [resolve(root, script), ...args], {
        cwd: root,
        stdio: 'inherit',
        env: {
          ...process.env,
          FORGEAX_VERIFIED_IDE_CANDIDATE_DIGEST: authorization.candidateDigest,
          FORGEAX_VERIFIED_INTEGRATION_REVISION: authorization.integrationRevision,
        },
      });
      if (result.status !== 0) throw new Error(`${script} failed with status ${result.status ?? 1}`);
    }
  } catch (error) {
    console.error(`VERIFIED_MIRROR_BOUNDARY: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(3);
  }
}
