import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import jsdoc from 'eslint-plugin-jsdoc';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import tseslint from 'typescript-eslint';

/**
 * Exported functions and the public methods of exported classes, the API whose
 * docs must tag every parameter and the return value. Accessors read as
 * properties and are left out, as are constructors.
 */
const PUBLIC_API = [
    'ExportNamedDeclaration > FunctionDeclaration',
    'ExportNamedDeclaration > ClassDeclaration > ClassBody > ' +
        'MethodDefinition[accessibility!="private"][kind="method"]' +
        '[key.type!="PrivateIdentifier"]',
];

export default defineConfig(
    {
        ignores: [
            'node_modules/',
            '.venv/',
            'output/',
            '.testpilot/',
            '.playwright-mcp/',
            'playwright-report/',
            'test-results/',
        ],
    },
    eslint.configs.recommended,
    tseslint.configs.strictTypeChecked,
    tseslint.configs.stylisticTypeChecked,
    jsdoc.configs['flat/recommended-typescript-error'],
    {
        languageOptions: {
            parserOptions: {
                projectService: {
                    allowDefaultProject: ['eslint.config.js', 'src/main.js'],
                },
                tsconfigRootDir: import.meta.dirname,
            },
        },
        plugins: { 'simple-import-sort': simpleImportSort },
        rules: {
            // Imports and exports kept sorted.
            'simple-import-sort/imports': 'error',
            'simple-import-sort/exports': 'error',
            // Every function states its return type.
            '@typescript-eslint/explicit-function-return-type': [
                'error',
                { allowExpressions: true, allowTypedFunctionExpressions: true },
            ],
            '@typescript-eslint/naming-convention': [
                'error',
                {
                    selector: 'default',
                    format: ['camelCase'],
                    leadingUnderscore: 'allow',
                },
                {
                    selector: 'variable',
                    format: ['camelCase', 'UPPER_CASE', 'PascalCase'],
                },
                { selector: 'typeLike', format: ['PascalCase'] },
                { selector: 'import', format: null },
                // Object keys mirror wire formats (JSON contract, OpenAI, MCP).
                { selector: ['objectLiteralProperty', 'typeProperty'], format: null },
            ],
            // A leading underscore marks a deliberately unused binding; a `using`
            // declaration is held for its disposal alone.
            '@typescript-eslint/no-unused-vars': [
                'error',
                {
                    argsIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                    ignoreUsingDeclarations: true,
                },
            ],
            '@typescript-eslint/restrict-template-expressions': [
                'error',
                { allowNumber: true, allowBoolean: true },
            ],
            // Doc comments on the exported API.
            'jsdoc/require-jsdoc': [
                'error',
                {
                    publicOnly: true,
                    require: {
                        ClassDeclaration: true,
                        FunctionDeclaration: true,
                        MethodDefinition: true,
                    },
                    checkConstructors: false,
                },
            ],
            // Parameter and return tags on exported functions and the public
            // methods of exported classes. An options object is documented as
            // one parameter, not field by field.
            'jsdoc/require-param': [
                'error',
                { contexts: PUBLIC_API, checkDestructured: false },
            ],
            'jsdoc/check-param-names': ['error', { checkDestructured: false }],
            'jsdoc/require-returns': ['error', { contexts: PUBLIC_API }],
            'jsdoc/require-yields': 'off',
            'jsdoc/require-throws': 'off',
            'jsdoc/tag-lines': ['error', 'any', { startLines: 1 }],
        },
    },
    {
        files: ['test/**/*.ts'],
        rules: {
            // Test doubles stand in for real objects with loose types.
            '@typescript-eslint/require-await': 'off',
            '@typescript-eslint/no-non-null-assertion': 'off',
        },
    },
    {
        files: ['*.config.ts', '*.config.js'],
        rules: { 'jsdoc/require-jsdoc': 'off' },
    },
    {
        // The plain-JavaScript executable runs under Node.
        files: ['src/main.js'],
        languageOptions: { globals: { console: 'readonly', process: 'readonly' } },
    },
    prettier,
);
