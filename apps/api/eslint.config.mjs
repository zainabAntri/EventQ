import nest from '@eventq/config/eslint/nest';

export default [
  ...nest,
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
];
