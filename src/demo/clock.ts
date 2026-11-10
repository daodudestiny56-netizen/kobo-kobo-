let offsetMs = 0;

export const now = (): Date => new Date(Date.now() + offsetMs);
export const getOffsetDays = (): number => offsetMs / 86_400_000;
export const setOffsetDays = (days: number): void => { offsetMs = days * 86_400_000; };
