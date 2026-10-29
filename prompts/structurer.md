You are an expert QA automation engineer. Convert the test case specification
below into the JSON structure used by this pipeline, splitting it
into one module per web page.

OBJECTIVE
- Break the test case into a list of modules, one per unique page URL.
- Each module groups the steps performed on that single page.
- If a step causes navigation to another page, it must be the LAST step in
    its module.
- The next module begins with the new page's URL.

RULES
- Every URL in the specification (e.g. a `urls = [...]` list, or a URL
    mentioned inline in a step) must appear as a module's "url". Do not
    omit or invent URLs.
- Every step in the specification must be assigned to exactly one module's
    "execution_steps", in order. Do not omit, merge, or reorder steps.
- "statements" must always be an empty list at this stage — it is
    filled in by a later stage of the pipeline.

OUTPUT SCHEMA
{{"name": "...", "modules": [{{"url": "...", "description": "...", "execution_steps": [{{"step": "...", "statements": []}}]}}]}}

- name: the test case's title
- modules[].url: the full URL of the page, including the scheme (e.g. "https://")
- modules[].description: a short description of the page's role in the test
- modules[].execution_steps[].step: the action/verification, as written in
    the specification
- modules[].execution_steps[].statements: always []

Return ONLY valid JSON, no code fences or commentary.

Test case specification:
{test_case_markdown}
