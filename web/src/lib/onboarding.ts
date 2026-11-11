import { ApiError } from './api/errors';

export type OnboardField = 'phone' | 'bankAccount' | 'bvn' | 'language';

export interface OnboardProblem {
  message: string;
  /** Set when the problem belongs to one input on the details step. */
  field?: OnboardField;
  /** Which step to show: 0 is the details, 1 is review and agree. */
  step: 0 | 1;
  /** Offer a link to sign in (the person already has an account). */
  signIn?: boolean;
  /** The consent text changed on the server, so reload it and ask again. */
  reloadConsent?: boolean;
}

// Every error code onboarding can return (src/onboarding/routes.ts and service.ts), in words a trader understands.
export function onboardProblem(e: unknown): OnboardProblem {
  if (!(e instanceof ApiError)) {
    return { message: 'Something went wrong. Please try again.', step: 1 };
  }
  switch (e.code) {
    case 'IDENTITY_NOT_VERIFIED':
      return { message: 'We could not verify this BVN. Check the number and try again.', field: 'bvn', step: 0 };
    case 'ACCOUNT_NOT_FOUND':
      return { message: 'We could not find that account. Check the number and try again.', field: 'bankAccount', step: 0 };
    case 'ACCOUNT_NOT_ACTIVE':
      return { message: 'This account is not active. Use an account that is open and active.', field: 'bankAccount', step: 0 };
    case 'NAME_MISMATCH':
      return { message: 'The name on your BVN does not match the name on this account. Use an account in your own name.', step: 0 };
    case 'NAME_NEEDS_REVIEW':
      return { message: 'The names on your BVN and this account are close but not identical, so they need to be checked by hand before we can open your pension.', step: 0 };
    case 'ALREADY_ENROLLED':
      return { message: 'These details are already enrolled. If this is your account, sign in instead.', step: 0, signIn: true };
    case 'CONSENT_REQUIRED':
      return { message: 'Please agree to the terms to continue.', step: 1 };
    case 'CONSENT_VERSION_MISMATCH':
      return { message: 'The terms have changed since you opened this page. Please read them again and agree.', step: 1, reloadConsent: true };
    case 'RATE_LIMITED':
      return { message: 'Too many attempts. Wait a minute and try again.', step: 1 };
    case 'BANK_UNAVAILABLE':
      return { message: 'We could not reach the bank just now. Try again in a moment.', step: 1 };
    case 'NETWORK':
      return { message: 'We could not reach Kobo Kobo. Check your connection and try again.', step: 1 };
    case 'INVALID_REQUEST': {
      const f = e.field;
      const field = f === 'phone' || f === 'bankAccount' || f === 'bvn' || f === 'language' ? f : undefined;
      return { message: e.message, field, step: field ? 0 : 1 };
    }
    default:
      return { message: e.message || 'Something went wrong. Please try again.', step: 1 };
  }
}
