/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Disable file tracing. Tracing produces .nft.json manifests that are only
  // consumed by `output: 'standalone'` (and Vercel's serverless bundling). We
  // ship via `next start` from a full node_modules install (see package.json
  // `start` script), so the manifests serve no purpose. Keeping it on causes
  // a hard build failure on Windows hosts: `python/.venv/` is created inside
  // WSL with Linux-style symlinks (e.g. `bin/python -> /usr/bin/python3`)
  // that resolve as broken on the NTFS side, and the trace walker scandirs
  // them and crashes with EACCES. The `experimental.outputFileTracingIgnores`
  // / `outputFileTracingExcludes` knobs do not stop the walk in this case
  // (the picomatch ignore check doesn't engage before glob hits the symlink).
  outputFileTracing: false,
  experimental: {
    // better-sqlite3 is a native module and must not be bundled by webpack
    // on the server side — let Next.js treat it as an external require.
    serverComponentsExternalPackages: ["better-sqlite3"],
  },
};

module.exports = nextConfig;
