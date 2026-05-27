import type { BrowserContext } from "playwright";

const NOT_IMPLEMENTED = "magnific-runtime: not implemented in S1 (foundation)";

export async function resolveExtensionId(
  _context: BrowserContext
): Promise<string> {
  void _context;
  throw new Error(NOT_IMPLEMENTED);
}

export async function injectToken(
  _context: BrowserContext,
  _token: string
): Promise<void> {
  void _context;
  void _token;
  throw new Error(NOT_IMPLEMENTED);
}
