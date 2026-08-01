import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  target: 'node22',

  dts: {
    sourcemap: true,
    cjsReexport: true,
  },

  sourcemap: true,
  clean: true,
  minify: false,

  exports: {
    legacy: true,
  },
});
