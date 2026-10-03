# Tool Output Limit

Limits the final text returned by direct `bash`, `grep`, and `read` calls
before it enters the model context. Streaming output keeps Pi's normal behavior
while a command is running. Image blocks returned by `read` are unchanged.
Structured results are preserved separately from the limited model-facing text.

## Configuration

The extension reads its section from
`$PI_CODING_AGENT_DIR/user-settings.json`:

```json
{
  "extensions": {
    "tool-output-limit": {
      "bash": 10,
      "grep": 10,
      "read": 10
    }
  }
}
```

Each tool has an independent limit in KiB. Supported values are `10`, `20`,
`30`, `40`, and `50`. Omit a tool to keep its native behavior. A value of `50`
also preserves Pi's native limit without additional processing. The extension
does nothing when the section is absent or empty, or when a configured value is
invalid.

The tools use strategies suited to their output:

- `bash` keeps 20% from the start and 80% from the end. It reuses Pi's complete
  output file when available, or saves the complete output to a mode-`0600`
  temporary file.
- `grep` keeps the ranked beginning of the result, preserves existing notices
  and cursor metadata, and recommends pagination or a narrower search.
- `read` keeps the beginning through a complete line when possible and reports
  the next line offset. It reports when one line is too large for line-based
  continuation. Image content is never truncated.

All retained text is valid UTF-8. Truncation markers are included in the
configured output-body limit; actionable notices are additional.

## Codemode

Nested calls, identified by `parentToolCallId`, bypass this extension. Their
results go to the calling tool or codemode script, not directly into the model
context. Scripts can filter or aggregate them before returning output. Pi's
native tool limits still apply; bypassing this extension does not make tool
output unlimited.

The final `codemode` result also uses Pi's native limit, not this extension's
per-tool KiB limits. Codemode defaults to 10,000 estimated output tokens. A
script can choose a different budget with a first-line option:

```js
// @options: {"max_output_tokens": 2000}
```

When its text exceeds that budget, Pi keeps the beginning and end, saves the
full text to a temporary file, and returns the path. This is a script-controlled
budget, not a global limit enforced by this extension.

Run `/reload` after changing the configuration.
