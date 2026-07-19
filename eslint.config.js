import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    {
        ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'output/**'],
    },
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ['**/*.{ts,tsx}'],
        rules: {
            'no-undef': 'off',
            'no-control-regex': 'off',
            'no-empty': 'off',
            'no-useless-assignment': 'off',
            'no-useless-escape': 'off',
            'prefer-const': 'off',
            'preserve-caught-error': 'off',
            'no-unused-vars': 'off',
            '@typescript-eslint/no-explicit-any': 'error',
            '@typescript-eslint/no-unused-vars': 'off',
        },
    },
);
