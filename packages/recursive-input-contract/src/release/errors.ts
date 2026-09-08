export type ReleaseIntegrityStatus = 'failed' | 'unverified';

export type ReleaseIntegrityError = {
  code: `release-integrity.${string}`;
  status: ReleaseIntegrityStatus;
  gate: string;
  expected: string;
  actual: string;
  candidateId?: string;
  subjectId?: string;
  target?: string;
  retryable: boolean;
  recoveryActions: string[];
};

export type ReleaseIntegrityValidation<T> = {
  ok: true;
  value: T;
} | {
  ok: false;
  error: ReleaseIntegrityError;
};

export function releaseIntegrityError(
  code: string,
  gate: string,
  expected: string,
  actual: string,
  options: Partial<Omit<ReleaseIntegrityError, 'code' | 'gate' | 'expected' | 'actual'>> = {},
): ReleaseIntegrityError {
  return {
    code: `release-integrity.${code}`,
    status: options.status ?? 'failed',
    gate,
    expected,
    actual,
    candidateId: options.candidateId,
    subjectId: options.subjectId,
    target: options.target,
    retryable: options.retryable ?? false,
    recoveryActions: options.recoveryActions ?? ['inspect-candidate', 'create-new-attempt'],
  };
}

export function validationFailure<T>(error: ReleaseIntegrityError): ReleaseIntegrityValidation<T> {
  return { ok: false, error };
}
