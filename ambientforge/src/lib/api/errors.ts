import { NextResponse } from 'next/server';

export type ApiErrorBody = {
  error: { code: string; message: string; details?: unknown };
};

export function errorJson(
  code: string,
  message: string,
  status: number,
  details?: unknown,
): NextResponse<ApiErrorBody> {
  const body: ApiErrorBody = { error: { code, message } };
  if (details !== undefined) body.error.details = details;
  return NextResponse.json(body, { status });
}
