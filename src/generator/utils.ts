/** Helpers for the Generator: settings, prompt steps, and checking the LLM's script. */

import ts from 'typescript';

import type { ExecutionStep, StepStatement } from '../model/test-case.ts';

// Playwright Test's default per-test timeout.
const DEFAULT_TEST_TIMEOUT_MS = 30_000;

// The timeout allows this many times the measured run time, as the site may be
// slower on another run.
const TIMEOUT_MARGIN = 2;

// A `timeout: <ms>` option, its value written with or without `_` separators.
const TIMEOUT_OPTION = String.raw`timeout:\s*([\d_]+)`;

// Where the LLM may put the timeout option, in the order tried: an options
// object of its own (with the comma before it), after an existing option,
// before one.
const TIMEOUT_PLACEMENTS = [
    new RegExp(String.raw`(?:,\s*)?\{\s*${TIMEOUT_OPTION}\s*,?\s*\}`),
    new RegExp(String.raw`,\s*${TIMEOUT_OPTION}`),
    new RegExp(String.raw`${TIMEOUT_OPTION}\s*,\s*`),
];

/**
 * Pins the locale these locators were validated under, quoted the way
 * Playwright's codegen quotes the statements.
 */
export function localeSetting(locale: string): string {
    return `test.use({ locale: '${locale}' });`;
}

/**
 * Raises the test's timeout to fit how long its statements took to replay.
 *
 * @param runTimeMs - How long the validated statements took, back to back.
 * @returns The setting, rounded up to whole 10s; `undefined` when Playwright's
 *   default already leaves the margin.
 */
export function timeoutSetting(runTimeMs: number): string | undefined {
    const seconds = Math.ceil((runTimeMs * TIMEOUT_MARGIN) / 10_000) * 10;
    if (seconds * 1000 <= DEFAULT_TEST_TIMEOUT_MS) {
        return undefined;
    }
    return `test.setTimeout(${seconds}_000);`;
}

/** The prompt's step blocks: each step's text, then its statements. */
export function describeSteps(steps: ExecutionStep[]): string {
    return steps
        .map((step) =>
            step.statements.length > 0
                ? [
                      `STEP: ${step.step}`,
                      ...step.statements.map(describeStatement),
                  ].join('\n')
                : `STEP: ${step.step}\n(no statements)`,
        )
        .join('\n\n');
}

/** Remove a surrounding Markdown code fence, if the LLM added one. */
export function stripFence(text: string): string {
    const lines = text.trim().split('\n');
    if (
        lines.length > 1 &&
        lines[0]?.startsWith('```') &&
        lines.at(-1)?.trim() === '```'
    ) {
        return lines.slice(1, -1).join('\n');
    }
    return text;
}

/** The syntax errors in `script`, as `line:column message` strings. */
export function syntaxDiagnostics(script: string): string[] {
    const { diagnostics = [] } = ts.transpileModule(script, {
        fileName: 'generated.spec.ts',
        reportDiagnostics: true,
        compilerOptions: {
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ES2022,
        },
    });
    return diagnostics.map((diagnostic) => {
        const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
        if (diagnostic.file === undefined || diagnostic.start === undefined) {
            return message;
        }
        const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(
            diagnostic.start,
        );
        return `${line + 1}:${character + 1} ${message}`;
    });
}

/**
 * Return the `required` statements not written, in order, in `script`, as the
 * prompt showed them.
 */
export function missingLines(script: string, required: StepStatement[]): string[] {
    const lines = script.split('\n').map((line) => line.trim());
    const missing: string[] = [];
    let position = 0;
    for (const wanted of required.filter((s) => s.code.trim() !== '')) {
        const found = lines.findIndex(
            (line, index) => index >= position && writes(line, wanted),
        );
        if (found === -1) {
            missing.push(describeStatement(wanted).trim());
        } else {
            position = found + 1;
        }
    }
    return missing;
}

/**
 * A statement as the prompt shows it: its code, followed by its measured
 * timeout as `  [timeout: <ms>]` when it has one.
 */
function describeStatement(statement: StepStatement): string {
    return statement.timeout === undefined
        ? statement.code
        : `${statement.code}  [timeout: ${formatMs(statement.timeout)}]`;
}

/**
 * Whether a script line is the statement, as the LLM was asked to write it.
 *
 * @param line - A line of the script, trimmed.
 * @param statement - The validated statement.
 * @returns True if `line` is the statement's code verbatim and, when it has a
 *   timeout, with exactly that timeout added as a matcher option.
 */
function writes(line: string, statement: StepStatement): boolean {
    const code = statement.code.trim();
    if (statement.timeout === undefined) {
        return line === code;
    }
    for (const placement of TIMEOUT_PLACEMENTS) {
        const match = placement.exec(line);
        if (match !== null) {
            const ms = Number(match[1]?.replaceAll('_', ''));
            const rest =
                line.slice(0, match.index) + line.slice(match.index + match[0].length);
            return (
                ms === statement.timeout &&
                rest === code &&
                match.index >= (argumentsStart(line) ?? Infinity)
            );
        }
    }
    return false;
}

/**
 * Where the arguments of a statement's outermost call begin: past
 * `.toBeVisible` in `await expect(locator).toBeVisible()`, so an option found
 * from there on is the matcher's (or the action's) and not the locator's.
 *
 * @param line - A statement, trimmed.
 * @returns The offset in `line`; `undefined` when it is not a call.
 */
function argumentsStart(line: string): number | undefined {
    const source = ts.createSourceFile('statement.ts', line, ts.ScriptTarget.Latest);
    const [first] = source.statements;
    if (first === undefined || !ts.isExpressionStatement(first)) {
        return undefined;
    }
    let expression = first.expression;
    while (
        ts.isAwaitExpression(expression) ||
        ts.isParenthesizedExpression(expression)
    ) {
        expression = expression.expression;
    }
    return ts.isCallExpression(expression) ? expression.expression.end : undefined;
}

/** Milliseconds with `_` thousands separators, as Playwright code writes them. */
function formatMs(ms: number): string {
    return String(ms).replace(/\B(?=(\d{3})+(?!\d))/g, '_');
}
