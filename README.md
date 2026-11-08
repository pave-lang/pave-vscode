# Pave VS Code Extension

Currently unpublished, can be built and installed locally using `npm install` and `npm run package-install`, making sure to also have the main pave repository in ../pave

## Running tests

The language server puts **Run test** above each `test` block, and **Run all tests in file** above the first one; **Pave: Run All Tests** is in the command palette. Each builds the test program with `pave.test.buildCommand`, then runs `pave.test.program` (a `pavec --test` build) in the terminal panel, where it reports TAP.

For the pave repository on Windows:

```json
{
  "pave.test.buildCommand": ["C:/Program Files/Git/bin/bash.exe", "-lc", "make test-build"],
  "pave.test.program": "build/tests/tests.exe"
}
```
