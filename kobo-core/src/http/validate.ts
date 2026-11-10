import type { ZodTypeAny, z } from 'zod';
import { AppError } from '../errors';

export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    const issues = r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw new AppError('VALIDATION_ERROR', issues.map((i) => `${i.path || 'body'}: ${i.message}`).join('; '), 400, { issues });
  }
  return r.data;
}
