import { expect, test } from 'bun:test';

import {
  EDITOR_REPOSITORY,
  EDITOR_TYPECHECK_EVIDENCE_SCHEMA,
  validateEditorTypecheckEvidence,
} from './verify-editor-typecheck';

const SHA = 'a'.repeat(40);

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    schema: EDITOR_TYPECHECK_EVIDENCE_SCHEMA,
    status: 'passed',
    repository: EDITOR_REPOSITORY,
    deliveredSha: SHA,
    checkName: 'typecheck',
    checkRun: {
      id: 123,
      name: 'typecheck',
      status: 'completed',
      conclusion: 'success',
      headSha: SHA,
    },
    ...overrides,
  };
}

function errorCode(run: () => unknown) {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  throw new Error('expected validation to fail');
}

test('accepts a successful Editor typecheck bound to the delivered SHA', () => {
  expect(validateEditorTypecheckEvidence(evidence(), { expectedSha: SHA })).toMatchObject({
    repository: EDITOR_REPOSITORY,
    deliveredSha: SHA,
  });
});

test('rejects Editor typecheck evidence from another SHA or check state', () => {
  expect(errorCode(() => validateEditorTypecheckEvidence(evidence({ deliveredSha: 'b'.repeat(40) }), { expectedSha: SHA }))).toBe('editor-typecheck-sha-mismatch');
  expect(errorCode(() => validateEditorTypecheckEvidence(evidence({ checkRun: { ...evidence().checkRun, headSha: 'b'.repeat(40) } })))).toBe('editor-typecheck-check-mismatch');
  expect(errorCode(() => validateEditorTypecheckEvidence(evidence({ checkRun: { ...evidence().checkRun, conclusion: 'failure' } })))).toBe('editor-typecheck-check-mismatch');
});
