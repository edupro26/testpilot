/** Helpers for the Generator: settings, prompt steps, and checking the LLM's script. */

import ts from 'typescript';

import type { ExecutionStep, StepStatement } from '../model/test-case.ts';

// Playwright Test's default per-test timeout.
const DEFAULT_TEST_TIMEOUT_MS = 30_000;

// The timeout allows this many times the measured run time, as the site may be
// slower on another run.
const TIMEOUT_MARGIN = 2;

/**
 * Pins the locale these locators were validated under, quoted the way
 * Playwright's codegen quotes the statements.
 *
 * @param locale - The browser locale the statements were validated under.
 * @returns The `test.use({ locale })` line for the script.
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

/**
 * The prompt's step blocks: each step's text, then its statements.
 *
 * @param steps - The validated steps, in order.
 * @returns One `STEP:` block per step, separated by blank lines; a step with
 *   no statements says so.
 */
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

/**
 * Remove a surrounding Markdown code fence, if the LLM added one.
 *
 * @param text - The LLM's reply.
 * @returns The lines inside the fence; `text` unchanged if it has none.
 */
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

/**
 * The syntax errors in `script`, as `line:column message` strings.
 *
 * @param script - The generated TypeScript test.
 * @returns One string per error, 1-based; empty if the script parses. An
 *   error with no position is its message alone.
 */
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
 *
 * Statements are compared token by token, so how the LLM lays one out (wrapped
 * across lines, with a comment, or with a formatter's trailing comma) is its own.
 *
 * @param script - The generated TypeScript test.
 * @param required - The validated statements, in order; blank ones are skipped.
 * @returns Each statement not found after the previous one found, with its
 *   timeout as the prompt showed it; empty if all are written.
 */
export function missingStatements(script: string, required: StepStatement[]): string[] {
    const written = scriptStatements(script);
    const missing: string[] = [];
    let position = 0;
    for (const wanted of required.filter((s) => s.code.trim() !== '')) {
        const found = written.findIndex(
            (node, index) => index >= position && writes(node, wanted),
        );
        if (found === -1) {
            missing.push(describeStatement(wanted).trim());
        } else {
            position = found + 1;
        }
    }
    return missing;
}

/** Every expression statement in `script`, nested ones included, in order. */
function scriptStatements(script: string): ts.ExpressionStatement[] {
    const source = ts.createSourceFile(
        'script.ts',
        script,
        ts.ScriptTarget.Latest,
        true,
    );
    const found: ts.ExpressionStatement[] = [];
    const visit = (node: ts.Node): void => {
        if (ts.isExpressionStatement(node)) {
            found.push(node);
        }
        node.forEachChild(visit);
    };
    visit(source);
    return found;
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
 * Whether a script statement is the validated one, as the LLM was asked to
 * write it.
 *
 * @param node - A statement of the script.
 * @param statement - The validated statement.
 * @returns True if `node` is the statement's code and, when it has a timeout,
 *   with exactly that timeout added as an option of its outermost call: the
 *   matcher's or the action's, not the locator's.
 */
function writes(node: ts.ExpressionStatement, statement: StepStatement): boolean {
    const code = tokens(statement.code);
    if (statement.timeout === undefined) {
        return tokens(node.getText()) === code;
    }
    const option = timeoutOption(node);
    if (option?.ms !== statement.timeout) {
        return false;
    }
    const text = node.getSourceFile().text;
    const rest =
        text.slice(node.getStart(), option.start) + text.slice(option.end, node.end);
    return tokens(rest) === code;
}

/**
 * The `timeout` option among the arguments of a statement's outermost call,
 * and the span to cut to remove it: the whole options object (with the comma
 * before it) when it holds nothing else, or the property and a comma beside it.
 */
function timeoutOption(
    node: ts.ExpressionStatement,
): { ms: number; start: number; end: number } | undefined {
    let expression = node.expression;
    while (
        ts.isAwaitExpression(expression) ||
        ts.isParenthesizedExpression(expression)
    ) {
        expression = expression.expression;
    }
    if (!ts.isCallExpression(expression)) {
        return undefined;
    }
    const args = expression.arguments;
    for (const [index, arg] of args.entries()) {
        if (!ts.isObjectLiteralExpression(arg)) {
            continue;
        }
        const properties = arg.properties;
        const at = properties.findIndex(
            (property) =>
                ts.isPropertyAssignment(property) &&
                property.name.getText() === 'timeout' &&
                ts.isNumericLiteral(property.initializer),
        );
        const property = properties[at] as ts.PropertyAssignment | undefined;
        if (property === undefined) {
            continue;
        }
        const ms = Number(property.initializer.getText().replaceAll('_', ''));
        if (properties.length === 1) {
            const before = args[index - 1];
            return before === undefined
                ? { ms, start: arg.getStart(), end: arg.end }
                : { ms, start: before.end, end: arg.end };
        }
        const next = properties[at + 1];
        return next === undefined
            ? { ms, start: (properties[at - 1] as ts.Node).end, end: property.end }
            : { ms, start: property.getStart(), end: next.getStart() };
    }
    return undefined;
}

/**
 * Code as a string of its tokens, comments and layout left out, and a trailing
 * comma before a closing bracket too.
 */
function tokens(code: string): string {
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, true);
    scanner.setText(code);
    const found: string[] = [];
    for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken;) {
        found.push(scanner.getTokenText());
        kind = scanner.scan();
    }
    return found
        .filter(
            (token, index) => token !== ',' || !/^[)\]}]$/.test(found[index + 1] ?? ''),
        )
        .join(' ');
}

/** Milliseconds with `_` thousands separators, as Playwright code writes them. */
function formatMs(ms: number): string {
    return String(ms).replace(/\B(?=(\d{3})+(?!\d))/g, '_');
}
