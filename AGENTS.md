# TestPilot

> **Audience**: LLM-driven agents

## Repository map

```
docs/                               # APP_DESCRIPTION.md (design), ROADMAP.md (next steps)
examples/                           # sample test-case markdown inputs, grouped by target site
output/                             # gitignored; this repo's scriptsDir is output/testpilot/ (generated specs)
.testpilot/                         # config.json (committed); logs/, tests/ (JSON per run), .playwright-mcp/ (gitignored)
prompts/                            # one template per pipeline stage ({{placeholder}} syntax)
skills/testpilot/                   # the agent skill (SKILL.md + references/) that `testpilot init --skills` copies into a project or the user's home
src/
├── cli/                            # the testpilot program: cli.ts (commands), one file per command (generate, doctor, init, config), skills.ts (skill destinations and install)
├── extractor/                      # agent drives Playwright MCP, collects emitted code
├── generator/                      # LLM assembles the script around the validated statements
├── llm/                            # LLM provider abstraction: protocol, factory, provider/
├── model/                          # shared JSON-contract schemas (TestCase, StepStatement, ...)
├── runtime/                        # pipeline.ts (runPipeline, extract-then-validate loop) + exceptions.ts
├── structurer/                     # markdown -> structured JSON
├── validator/                      # browser.ts (replay) + service.ts (semantic check)
├── config.ts                       # Settings (zod) + configureLogging
├── error-codes.ts                  # ERROR_CODES: stable error codes, exit codes, hints
├── logger.ts                       # levelled, coloured stderr logger; also appends to the run's log file
├── main.js                         # the testpilot executable: checks Node, runs the CLI
└── prompt-loader.ts                # loadPrompt / renderPrompt
test/                               # Vitest suite mirroring src/
playwright.config.ts                # runs the generated specs in output/testpilot/
```

## Rules & Code conventions

1. **Language**: TypeScript, run directly by Node.js ≥ 24 (type stripping, no build step)
2. **Package management**: ONLY use `npm`; never edit `package-lock.json` by hand
3. **Line length**: 88 characters maximum (Prettier `printWidth`)
4. **Imports**: Relative imports with the `.ts` extension, sorted by `simple-import-sort`
5. **Type safety**: `strict` TypeScript; every function declares its return type
6. **Erasable syntax only**: no `enum`, `namespace` or constructor parameter properties
7. **Naming**: `camelCase` functions and variables, `PascalCase` classes and types, `kebab-case` file names
8. **Doc comments**: TSDoc (`/** ... */`, `@param name -`, `@returns`, `@throws {Type}`) for all exported APIs
9. **Commits**: Never mention tools/AI
10. **Commit Type**: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`
11. **File hygiene**: Prefer editing existing files over creating new ones

## Dev workflow

```
npm ci                               # install dependencies
npx playwright install               # browsers for testpilot's Playwright (once, and after a Playwright upgrade)
npm run typecheck                    # type-check (tsc)
npm run lint                         # lint (ESLint, type-aware)
npm run format                       # format (Prettier)
npm test                             # run the test suite (Vitest)
npm run check                        # all of the above, without writing

npm link                             # once: puts `testpilot` on the PATH
testpilot doctor                     # check the setup; prints the fix for anything missing
testpilot init                       # set the project up: create .testpilot/ (safe to re-run)
testpilot init --skills[=<agent>] [-g] # install the skill from skills/testpilot/ (agents, the default, copilot or claude; -g: user's home); re-run to update
testpilot --version                  # print the installed version
testpilot config list                # every effective setting and where it came from
testpilot config set-azure-openai    # write the Azure OpenAI settings (--help for flags)
testpilot generate <path.md>         # or, without linking: npm run --silent testpilot -- generate <path.md>
testpilot generate <path.md> --json  # the result as one JSON object on stdout (exit 0, 1 or 2)
                                     # flags: --headed --out --max-turns --locale --log-level
npx playwright test <output/testpilot/x.spec.ts>
```

### Playwright MCP (runs in-process)

The Extractor drives a real browser through Playwright MCP. The server runs
inside the application (`createConnection` from `@playwright/mcp`) and the
client talks to it over an in-memory transport, so there is no server to start
and no port to configure. A retry reset closes the session and opens a new one.

Each session gets a freshly launched Chromium (headless, or headed with `generate --headed`), whose context
(locale from the `locale` setting) is handed to the server (`playwrightServer()` in
`src/extractor/mcp/server.ts`). A fresh browser means a fresh profile, so
consent banners reappear every run: with a persisted profile the agent never
learns to dismiss them and the generated script trips over one. The
application owns that browser and closes it with the session; Playwright MCP
leaves a browser it launched itself running when its server closes.

The server's configuration (`mcpConfig()`):

| Key | Why it matters |
|---|---|
| `codegen: "typescript"` | The whole mechanism. Each tool result reports the TypeScript statement it ran (in a `` ```js `` fence), which is what the Extractor collects. TypeScript is the only language every tool honours. |
| `capabilities: ["testing"]` | Adds the `browser_verify_*` assertion tools. Without them a verification step has no assertion to collect. |
| `browser.isolated: false` | Use the context the session is given; `true` would make the server try to open a context of its own. |
| `outputDir` | `.testpilot/.playwright-mcp` under the project root, absolute: Playwright MCP resolves a relative one against the working directory, which may be a project subfolder. |

### One Playwright

`@playwright/mcp` is a thin wrapper over `playwright-core`, and pins an alpha
build of it. The `overrides` entry in `package.json` points it at the same
Playwright as `@playwright/test`, so Playwright MCP, the validation browser and
the generated tests share one install and one browser build. Upgrade
`@playwright/test` and `@playwright/mcp` together; the startup check fails
loudly (naming the tools) if the new tool surface no longer offers an
allowlisted tool.
