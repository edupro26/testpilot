# Test case format

Read this before you write a test case file, or check one the developer wrote.
`testpilot generate <path.md>` takes one markdown file in this format. The format
is fixed: do not add sections, front matter or other syntax.

## Template

```markdown
# <the test's name>

urls = ["<full URL of the first page>", "<full URL of the next page>"]

## Steps

1. Launch browser and navigate to url '<full URL of the first page>'
2. Verify that <what is visible on the first page>
3. Click on the '<exact text>' button
4. Verify that <what is visible on the next page>
```

All three parts are required, in this order, with a blank line between them:

1. `# <title>`: the test's name, on one line.
2. `urls = [...]`: a JSON array of strings, on one line. List every page the test
   visits, in the order it visits them, including pages reached by a click, not
   only the ones the developer named. Each URL is complete, with its scheme
   (`https://...`), because testpilot uses them as written.
3. `## Steps`, then a numbered list (`1.`, `2.`, ...), one step per item, one line each.

## Writing the steps

- One action or one verification per step. Split "log in and open the cart" into
  separate steps.
- The first step navigates to the first URL: `Launch browser and navigate to url '<url>'`.
- Quote visible text exactly as the page shows it, in single quotes, with its
  spelling, accents and capitalisation: `Click on the 'Login' button`. Do not
  translate it.
- A verification starts with `Verify that`:
  `Verify that the error message 'Your email or password is incorrect!' is visible`.
- When a page has several alike elements (buttons, options, list items), say which
  one. Name it by position or by what sets it apart:
  `Click the 'Aderir já' button of the first mobile plan in the list`, or
  `Verify that the 'Móvel' product option is visible (the mobile-only option, not 'Móvel + Net Fixa' or another bundle)`.
- Write values such as usernames, passwords and postal codes literally in the
  step (`Enter the username 'standard_user' and the password 'secret_sauce'`).
  Variables and placeholders are not supported yet.

Example:

```text
# Login with Standart User

urls = ["https://www.saucedemo.com/","https://www.saucedemo.com/inventory.html"]

## Steps

1. Launch browser and navigate to url 'https://www.saucedemo.com/'
2. Verify that the Login Section is visible successfully
3. Enter the username 'standard_user' and the password 'secret_sauce'
4. Click on the 'Login' button
5. Verify that the Inventory Page is visible successfully
```

Match this style, whatever the test's length.

## What testpilot does with it

The Structurer splits the steps into one group per page, using the `urls` list. A
step that moves the browser to another page is the last step of the page it leaves,
and the next page's steps follow it. So keep the `urls` order identical to the
order the test visits the pages, and never put a step that depends on the next page
before the step that opens it. Then testpilot has an agent drive a real browser
through each step. Every step must be something that agent can do or check in the
browser. Do not write steps that need anything outside it (reading an email or an
SMS, opening a file on disk, another application, a manual wait for something else).

## Where a new file goes

Write a new file only after the developer has given you the steps (see `SKILL.md`).

1. Look in the project for a folder that already holds testpilot test cases. Recognise
   one by content, not by name: `.md` files with a `# title`, a `urls = [...]` line
   and a `## Steps` list. If there is one such folder, save the new file there.
2. If there are several, ask the developer which one to use.
3. If there is none, create `.testpilot/input/` and save the file there. That folder
   is committed with the project.

Name the file after the test, in lowercase with underscores, starting with `test_`
(for example `test_add_cart.md`).
