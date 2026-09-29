import { spawn } from 'node:child_process';

const repository = process.env.GITHUB_REPOSITORY;

function parseArgs(argv) {
  const options = { runId: process.env.GITHUB_RUN_ID };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--run-id') {
      options.runId = argv[++index];
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

const { runId } = parseArgs(process.argv.slice(2));

if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')) {
  throw new Error('GITHUB_REPOSITORY must be an owner/name pair');
}
if (!/^\d+$/.test(runId ?? '')) {
  throw new Error('the workflow run id must be numeric');
}

function runGh(args) {
  return new Promise((resolve) => {
    const child = spawn('gh', args, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('error', () => resolve({ code: 1, stdout: '' }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout }));
  });
}

const listed = await runGh([
  'api',
  '--paginate',
  `repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`,
  '--jq',
  '.artifacts[].id',
]);

if (listed.code !== 0) {
  console.log('::warning::could not list transient artifacts for this run');
  process.exit(0);
}

let deleted = 0;
let failed = 0;
for (const artifactId of listed.stdout.split(/\s+/).filter(Boolean)) {
  const result = await runGh([
    'api',
    '--method',
    'DELETE',
    `repos/${repository}/actions/artifacts/${artifactId}`,
  ]);
  if (result.code === 0) deleted += 1;
  else failed += 1;
}

console.log(`transient artifacts deleted: ${deleted}; failed deletions: ${failed}`);
if (failed !== 0) {
  console.log('::warning::some transient artifacts could not be deleted; inspect the job log');
}
