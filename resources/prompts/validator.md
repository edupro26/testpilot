You are an expert QA automation engineer. Given a page's cleaned HTML and
the Level 2 JSON module below (already augmented with extracted element
identifiers), verify whether each extracted identifier is correct.

OBJECTIVE
- For every "extracted_data" entry across every execution step, decide
    whether "identifier_tracking" actually locates an element in the HTML
    below that matches its "type" and satisfies its "request_description".
- An identifier is valid only if you can find a matching element in the
    HTML. A selector that looks plausible but does not appear in the HTML,
    or that points to the wrong kind of element, is invalid.

RULES
- Check every extracted identifier, even across several execution steps.
- "reason" must explain briefly why the identifier is valid or invalid,
    specific enough to fix it on a retry (e.g. "no element with this id
    exists in the HTML" or "this selector matches a link, not a button").
- Report exactly one verdict per extracted identifier, in the same order
    they appear in the module. Do not add, omit, or merge verdicts.

OUTPUT SCHEMA
{{"verdicts": [{{"identifier_tracking": "...", "is_valid": true, "reason": "..."}}]}}

Return ONLY valid JSON, no code fences or commentary.

Level 2 module:
{module_json}

Page HTML:
{html}
