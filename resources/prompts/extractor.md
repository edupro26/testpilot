You are an expert QA automation engineer. Given a page's cleaned HTML and
the Level 1 JSON module below, decide which UI elements each execution step
needs to interact with or verify, and fill in "extracted_data" for every
step.

OBJECTIVE
- For each execution step, identify the UI elements on the page it needs
    to locate: elements to click, fields to fill, or text/messages to
    read for a verification.
- A step that does not require locating anything on this page (e.g. it
    only navigates to another page) must get an empty "extracted_data"
    list. Do not invent elements for it.
- A step may need more than one extracted element (e.g. "enter an
    incorrect email and password" needs both the email field and the
    password field).

RULES
- Preserve "url", "description", and every "step" text exactly as given.
    Do not omit, merge, reorder, or reword any execution step.
- Only extract data that is actually present in the HTML below. Never
    invent a selector for an element you cannot find.
- Prefer stable identifiers, in this order of preference: an "id"
    attribute, then a `data-*` attribute, then other CSS-selectable
    attributes (class, name, type, placeholder), then visible text as a
    last resort.
- "type" must be exactly one of: "button", "link", "input", "checkbox",
    "dropdown", "text", "other".
- "identifier_type" must be exactly one of: "id", "css", "xpath", "text".
    "identifier_tracking" must match its type's format:
    - "id": the element's "id" attribute value alone (e.g. "login-button"),
        without a leading "#".
    - "css": a full CSS selector (e.g. "[data-qa='login-button']").
    - "xpath": a full XPath expression (e.g. "//button[text()='Login']").
    - "text": the element's exact visible text (e.g. "Login").
- "request_description": a short description of what the element is for,
    in this execution step's context.

OUTPUT SCHEMA
{{"url": "...", "description": "...", "execution_steps": [{{"step": "...", "extracted_data": [{{"type": "...", "request_description": "...", "identifier_type": "...", "identifier_tracking": "..."}}]}}]}}

Return ONLY valid JSON, no code fences or commentary.
{feedback_section}
Level 1 module:
{module_json}

Page HTML:
{html}
