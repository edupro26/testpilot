/** Tests for src/structurer/service. */

import { expect, test } from 'vitest';

import { StructurerError } from '../../src/exceptions.ts';
import { MockProvider } from '../../src/llm/provider/mock.ts';
import { Structurer } from '../../src/structurer/service.ts';

const VALID_RESPONSE = JSON.stringify({
    name: 'Login User with Incorrect Credentials',
    modules: [
        {
            url: 'https://automationexercise.com',
            description: 'Reach the login page',
            execution_steps: [{ step: 'Click Signup / Login' }],
        },
    ],
});

test('run returns a test case for a valid LLM response', async () => {
    // A well-formed JSON response is parsed into a TestCase.
    const structurer = new Structurer(new MockProvider(VALID_RESPONSE));

    const testCase = await structurer.run('# Login User with Incorrect Credentials');

    expect(testCase.name).toBe('Login User with Incorrect Credentials');
    expect(testCase.modules[0]?.url).toBe('https://automationexercise.com');
});

test('run raises StructurerError for a bad LLM response', async () => {
    // Non-JSON or wrongly shaped JSON raises StructurerError, not a raw error.
    const notJson = new Structurer(new MockProvider('not valid json'));
    await expect(notJson.run('# Some test case')).rejects.toThrow(StructurerError);
    await expect(notJson.run('# Some test case')).rejects.toThrow(/not valid JSON/);

    const wrongShape = new Structurer(
        new MockProvider(JSON.stringify({ unexpected: 'shape' })),
    );
    await expect(wrongShape.run('# Some test case')).rejects.toThrow(
        /did not match the TestCase shape/,
    );
});
