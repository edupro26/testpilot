/** Shared test setup. */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, vi } from 'vitest';

const SETTINGS_ENV_VARS = [
    'TESTPILOT_LLM_PROVIDER',
    'TESTPILOT_AZURE_OPENAI_ENDPOINT',
    'TESTPILOT_AZURE_OPENAI_API_KEY',
    'TESTPILOT_AZURE_DEPLOYMENT_NAME',
    'TESTPILOT_AZURE_MODEL_NAME',
    'TESTPILOT_OPENAI_API_VERSION',
    'TESTPILOT_SCRIPTS_DIR',
    'TESTPILOT_LOCALE',
    'TESTPILOT_MAX_TURNS',
    'TESTPILOT_LOG_LEVEL',
];

/**
 * Isolate settings from the real environment and any local .env file.
 *
 * Each test runs in a fresh temporary working directory, which is also where
 * the pipeline writes its `output/`.
 */
export function useIsolatedSettingsEnv(): void {
    let previousCwd = process.cwd();

    beforeEach(async () => {
        for (const key of SETTINGS_ENV_VARS) {
            vi.stubEnv(key, undefined);
        }
        previousCwd = process.cwd();
        process.chdir(await mkdtemp(path.join(tmpdir(), 'testpilot-')));
    });

    afterEach(() => {
        process.chdir(previousCwd);
        vi.unstubAllEnvs();
    });
}
