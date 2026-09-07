const friendlyErrors: Array<[RegExp, string]> = [
  [/jwt|session|refresh token/i, 'Your session expired. Sign in again.'],
  [
    /row-level security|permission|access denied|not allowed/i,
    'You do not have permission to do that.',
  ],
  [
    /network|fetch|offline/i,
    'The connection was interrupted. Your work is still safe.',
  ],
  [/storage|upload/i, 'The receipt image could not be uploaded. Try again.'],
  [/duplicate|23505/i, 'This item already exists.'],
  [
    /no unsettled expenses|no expenses to settle/i,
    'There are no receipts to settle for these dates.',
  ],
];

export function userError(
  error: unknown,
  fallback = 'Something went wrong. Try again.',
) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  return (
    friendlyErrors.find(([pattern]) => pattern.test(message))?.[1] ?? fallback
  );
}
