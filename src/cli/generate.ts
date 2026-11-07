/** `testpilot generate`: turn a markdown test case into a Playwright script. */

import { stat } from 'node:fs/promises';

import { errorMessage } from '../runtime/exceptions.ts';
import { runPipeline } from '../runtime/pipeline.ts';
import { fail, loadSettingsOrFail } from './errors.ts';

/**
 * Run the full pipeline on a markdown test case.
 *
 * @param markdownPath - The test case specification.
 * @throws {CliExit} With status 2 if the file is missing or the configuration
 *   is invalid, or 1 if a pipeline stage fails.
 */
export async function generateCommand(markdownPath: string): Promise<void> {
    const info = await stat(markdownPath).catch(() => undefined);
    if (!info?.isFile()) {
        fail(
            `error: invalid value for '<markdown_path>': ` +
                `file ${JSON.stringify(markdownPath)} does not exist.`,
            undefined,
            2,
        );
    }
    const settings = loadSettingsOrFail();
    try {
        await runPipeline(markdownPath, settings);
    } catch (error) {
        fail(errorMessage(error), error, 1, true);
    }
}
