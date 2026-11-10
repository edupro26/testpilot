/** Loading and rendering of prompt templates. */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { logger } from './logger.ts';

const PROMPTS_DIR = path.join(import.meta.dirname, '..', 'prompts');

// `{{name}}`: single braces are left alone, since TypeScript code in the
// templates is full of them.
const PLACEHOLDER = /\{\{(\w+)\}\}/g;

/**
 * Read the raw contents of a prompt template.
 *
 * @param name - Template name without extension, e.g. "structurer".
 * @returns The raw template text.
 * @throws {Error} If no template named `name` exists.
 */
export function loadPrompt(name: string): string {
    const text = readFileSync(path.join(PROMPTS_DIR, `${name}.md`), 'utf8');
    logger.debug(
        `Loaded prompt template ${JSON.stringify(name)} (${text.length} chars)`,
    );
    return text;
}

/**
 * Load a prompt template and fill in its placeholders.
 *
 * @param name - Template name without extension, e.g. "structurer".
 * @param values - Values to fill `{{placeholder}}` fields in the template.
 * @returns The rendered prompt text.
 * @throws {Error} If no template named `name` exists, or a placeholder in it
 *   has no value.
 */
export function renderPrompt(name: string, values: Record<string, string>): string {
    return loadPrompt(name).replace(PLACEHOLDER, (_match, key: string) => {
        const value = values[key];
        if (value === undefined) {
            throw new Error(`Prompt ${JSON.stringify(name)} needs a value for ${key}`);
        }
        return value;
    });
}
