/**
 * The Node.js version testpilot needs. Kept free of syntax that older Node
 * cannot parse, since it is checked before the rest of the CLI loads.
 */

/** The oldest Node.js major version testpilot runs on. */
export const MIN_NODE_MAJOR = 24;

/**
 * Why testpilot cannot run on Node.js `version`, if it cannot.
 *
 * @param version - A Node.js version, e.g. `process.versions.node`.
 * @returns The problem, below the minimum major version; else `undefined`.
 */
export function unsupportedNode(version: string): string | undefined {
    const major = Number(version.split('.')[0]);
    return major >= MIN_NODE_MAJOR
        ? undefined
        : `testpilot needs Node.js ${MIN_NODE_MAJOR} or newer; this is ${version}.`;
}
