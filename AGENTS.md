# Pi coding agent rules

## Configuration changes

- Before changing coding-agent configuration, check `PI_CODING_AGENT_DIR`. Use
  it when nonempty. Otherwise confirm the installed Pi version's default path
  from its documentation or configuration code. Ask if the path cannot be
  established.
- `PI_CONFIG_DIR` is for global Pi configuration, not coding-agent files. Do not
  use it as a fallback for `PI_CODING_AGENT_DIR`.

## Search

- For indexed project searches, prefer FFF-backed tools when available.
