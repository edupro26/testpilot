Decide which UI elements each numbered execution step below needs to
interact with or verify on this page, and return one object per needed
element.

OBJECTIVE
- For each step, identify the UI elements it needs to locate: elements to
    click, fields to fill, or text/messages to read for a verification.
- A step that does not require locating anything on this page (e.g. it
    only navigates to another page) needs no object at all. Do not invent
    elements for it.
- A step may need more than one element (e.g. "enter an incorrect email
    and password" needs both the email field and the password field).

RULES
- Reference each step by its 0-based index in "step_index" — do not
    paraphrase or repeat its text.
- Only extract data that is actually present in the page content. Never
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
    in its step's context.
- "input_value": for elements the step types into or selects a value on
    (inputs, dropdowns), a plausible literal value implied by the step
    (e.g. "enter an incorrect email" -> a made-up invalid-looking address).
    Omit it (or use null) for elements that are only clicked or read, such
    as buttons, links, or text being verified.

Steps:
{numbered_steps}
{feedback_section}
