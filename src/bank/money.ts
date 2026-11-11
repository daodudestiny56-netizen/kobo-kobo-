// The ONLY place floats are converted. Never multiply by 100 without rounding.
export const toKobo = (naira: number): number => Math.round(naira * 100);
export const toNaira = (kobo: number): number => kobo / 100;