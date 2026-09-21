import type { NextConfig } from 'next';

const config: NextConfig = {
  /**
   * `highs` is a WASM LP solver. Bundling it inlines the `.wasm` and the solve
   * fails at request time with nothing useful in the stack — so it stays
   * external and is required at runtime from node_modules.
   *
   * This is the single most forgettable line in the app and its failure is
   * silent until a real solve runs, which is why the health route below does
   * one on every boot.
   */
  serverExternalPackages: ['highs'],
  /**
   * The workspace packages are NodeNext ESM: their sources import siblings as
   * `./money.js` while the file on disk is `money.ts`. Node resolves that,
   * bundlers do not, so tell the resolver the same thing TypeScript already
   * knows. The alternative is pointing every package at built `dist/` output,
   * which would put a compile step in front of every dev reload.
   */
  webpack: (config, { isServer }) => {
    // `serverExternalPackages` does not reach `highs` here, because it is
    // imported from INSIDE a transpiled workspace package rather than from app
    // code. Left bundled, its CommonJS loader reaches for `createRequire` and
    // gets webpack's shim, which does not have it. Marking it external on the
    // server build makes Node require the real thing at runtime.
    if (isServer) {
      const externals = Array.isArray(config.externals) ? config.externals : [];
      config.externals = [...externals, { highs: 'commonjs highs' }];
    }
    config.resolve = config.resolve ?? {};
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
  transpilePackages: [
    '@polyhedge/core',
    '@polyhedge/engine',
    '@polyhedge/intake',
    '@polyhedge/questions',
    '@polyhedge/venue',
  ],
};

export default config;
