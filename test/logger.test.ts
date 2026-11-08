/** Tests for the logger's file sink. */

import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { lastLineAt, logger, setLogFile, setLogLevel } from '../src/logger.ts';
import { stderr, useCapturedOutput } from './helpers.ts';

describe('setLogFile', () => {
    useCapturedOutput();

    afterEach(() => {
        setLogFile(undefined);
        setLogLevel('INFO');
    });

    async function newLogFile(): Promise<string> {
        return path.join(await mkdtemp(path.join(tmpdir(), 'testpilot-log-')), 'x.log');
    }

    test('appends each line, plain, with error stacks, at the same threshold', async () => {
        const file = await newLogFile();
        setLogFile(file);

        logger.debug('hidden');
        logger.info('first');
        logger.error('second', new Error('boom', { cause: new Error('root') }));

        const log = readFileSync(file, 'utf8');
        expect(log).not.toContain('hidden');
        expect(log).not.toContain('\x1b[');
        expect(log).toMatch(/^\[\d\d:\d\d:\d\d\] \[INFO\] first\n/);
        expect(log).toContain('[ERROR] second\nError: boom');
        expect(log).toContain('Caused by:\nError: root');
        expect(log.endsWith('\n')).toBe(true);
    });

    test('a write failure warns once and never throws', async () => {
        setLogFile(path.join(await mkdtemp(path.join(tmpdir(), 'x-')), 'no', 'x.log'));

        expect(() => {
            logger.info('one');
            logger.info('two');
        }).not.toThrow();

        const warnings = stderr()
            .split('\n')
            .filter((l) => l.includes('Cannot write'));
        expect(warnings).toHaveLength(1);
    });

    test('always logs below the threshold', async () => {
        const file = await newLogFile();
        setLogFile(file);
        setLogLevel('ERROR');

        logger.info('hidden');
        logger.always('shown');

        expect(readFileSync(file, 'utf8')).toMatch(/\[INFO\] shown\n$/);
        expect(stderr()).toContain('shown');
        expect(stderr()).not.toContain('hidden');
    });

    test('stops when set to undefined', async () => {
        const file = await newLogFile();
        setLogFile(file);
        logger.info('kept');
        setLogFile(undefined);
        logger.info('dropped');

        const log = readFileSync(file, 'utf8');
        expect(log).toContain('kept');
        expect(log).not.toContain('dropped');
    });
});

describe('lastLineAt', () => {
    useCapturedOutput();

    afterEach(() => {
        setLogLevel('INFO');
        vi.useRealTimers();
    });

    test('is the time of the last line written, whatever its level', () => {
        vi.useFakeTimers({ now: 1_000 });
        logger.info('first');
        expect(lastLineAt()).toBe(1_000);

        vi.setSystemTime(2_000);
        logger.debug('dropped');
        expect(lastLineAt()).toBe(1_000);

        setLogLevel('ERROR');
        vi.setSystemTime(3_000);
        logger.always('shown');
        expect(lastLineAt()).toBe(3_000);
    });
});
