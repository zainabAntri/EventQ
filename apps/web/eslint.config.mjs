import next from '@eventq/config/eslint/next';

export default [
  ...next,
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
];
