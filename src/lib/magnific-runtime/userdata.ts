const NOT_IMPLEMENTED = "magnific-runtime: not implemented in S1 (foundation)";

export function resolveUserDataDir(): string {
  throw new Error(NOT_IMPLEMENTED);
}

export function ensureUserDataDir(_path: string): void {
  void _path;
  throw new Error(NOT_IMPLEMENTED);
}
