// The backend answers every failure with { error: { code, message, field? } } (see src/onboarding/routes.ts).
// Both the live client and the mock throw this, so screens can react to the code instead of parsing text.
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public field?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
