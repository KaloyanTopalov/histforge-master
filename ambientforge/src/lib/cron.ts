import cron from 'node-cron';
import { z } from 'zod';

export function isValidCron(expr: string): boolean {
  return cron.validate(expr);
}

export const cronSchema = z
  .string()
  .min(1)
  .refine(isValidCron, { message: 'Invalid cron expression (5-field standard)' });
