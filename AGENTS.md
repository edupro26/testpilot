# GenAI-Test-Script-Automation

> **Audience**: LLM-driven agents

## Repository map

```
docs/
output/                             # gitignored, per-run generated artifacts
resources/
src/
├── crawler/                        # Level 2, not yet implemented (M2)
├── extractor/                      # Level 2, not yet implemented (M2)
├── generator/                      # Level 3, not yet implemented (M3)
├── llm/                            # LLM provider abstraction: protocol, factory, provider/
├── model/                          # shared JSON-contract schemas (TestCase, Module, ...)
├── structurer/                     # Level 1: markdown -> structured JSON
├── validator/                      # Level 2, not yet implemented (M2)
├── cli.py                          # not yet implemented (M4)
├── config.py                       # Settings + logging configuration
├── exceptions.py                   # PipelineError, StructurerError, ConfigurationError
├── main.py                         # CLI entrypoint (structure command)
├── pipeline.py                     # not yet implemented (M4)
└── prompt_loader.py                # load_prompt / render_prompt
test/                               # pytest suite mirroring src/
```

## Rules & Code conventions

1. **Language**: Python ≥ 3.13
2. **Package management**: ONLY use `uv`, NEVER `pip`
3. **Line length**: 88 characters maximum
4. **Imports**: Absolute imports, sorted by Ruff
5. **Type safety**: All functions require type hints
6. **Naming**: `snake_case` functions, `PascalCase` classes
7. **Docstrings**: Google-style for all public APIs
8. **Commits**: Never mention tools/AI
9. **Commit Type**: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`
10. **File hygiene**: Prefer editing existing files over creating new ones

## Dev workflow

```
uv sync --locked --dev               # install dependencies
uv run ruff check --fix .            # code lint
uv run ruff format .                 # code format
uv run pytest -q                     # run the test suite

uv run python -m src.main <path.md>
```

*Tests must pass* and *lint/typing must be clean* before committing.