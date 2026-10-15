# Development

`cal_sync.js` is a single file pasted directly into Google Apps Script. Keep settings in `getConfiguration()` at the top. No build step or dependencies are needed.

## Local tests

With a recent Node.js version, run from the repository root:

```sh
node --check cal_sync.js
node --test tests/cal_sync.test.cjs
```

Tests use mocked `CalendarApp` and `Logger` services—no Google credentials or network access. They cover configuration validation, filtering, all-day matching, cleanup safeguards, and sync counts. They do not verify live permissions, feed refreshes, or Google's runtime.

## Making changes

- Keep the script pasteable: no Node APIs, imports, or dependencies.
- Keep real calendar IDs and personal configuration out of the repository.
- Complete preflight reads before writes; preserve unrelated manual events.
- Add regression tests for behavior changes and update the README when needed.

For Calendar behavior changes, also test in Apps Script with disposable calendars: run validation, sync timed and all-day events, then repeat to check for duplicates. Remove a source event and confirm only its managed copy is deleted.

When updating a live installation, preserve its `getConfiguration()` function, replace the remaining code, save, and run `syncTeamCalendar`. Local edits do not update the hosted project automatically.
