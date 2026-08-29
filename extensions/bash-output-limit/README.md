# Bash Output Limit

Limits the final text returned by Pi's built-in `bash` tool before it enters the
model context. Streaming output keeps Pi's normal behavior while the command is
running.

## Configuration

The extension reads its section from
`$PI_CODING_AGENT_DIR/user-settings.json`:

```json
{
  "extensions": {
    "bash-output-limit": {
      "maxKiB": 20
    }
  }
}
```

Supported values are `10`, `20`, `30`, `40`, and `50`. The extension does
nothing when the file, section, or `maxKiB` key is absent, or when the value is
invalid. A value of `50` preserves Pi's built-in limit without additional
processing.

For smaller values, the extension keeps 20% from the start and 80% from the
end of the command output. For example, a 20 KiB limit keeps the first 4 KiB
and last 16 KiB. Windows can start or end within a long line, but always remain
valid UTF-8. An explicit marker and footer tell the model that the middle was
omitted and provide the full-output path.

If Pi already saved the full output, the extension reads only the required head
and tail windows from that file and reuses its path. Otherwise, it saves the
complete result to a mode-`0600` temporary file. Markers and notices are
additional to the configured output-body limit.

Run `/reload` after changing the file.
