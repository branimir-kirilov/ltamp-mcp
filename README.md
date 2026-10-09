# ltamp-mcp

An [MCP](https://modelcontextprotocol.io) server that lets AI assistants work
with a Fender Mustang LT amp over USB: browse presets, design tones, play them
on the amp without saving, and save them, with history and undo for every
change.

Works with any MCP client: Claude Code, Claude Desktop, Cursor, VS Code and
others. Built on [ltamp-js](https://github.com/branimir-kirilov/ltamp-js).

> Unofficial. Not affiliated with or endorsed by Fender. Tested on the
> Mustang LT25 (firmware 2.1.4).

## Tools

| Tool | Changes the amp? |
|---|---|
| `amp_status`, `list_presets`, `get_preset`, `get_current_tone`, `get_catalog`, `history` | No |
| `audition_tone`, `stop_audition`, `load_preset` | Only what's playing; nothing is saved |
| `save_tone`, `undo` | Yes: writes a slot, recorded in history |

Safety:
- On first connection every run, all 60 slots are backed up to `~/.ltamp-mcp/snapshots/`.
- `save_tone` refuses to replace any slot that isn't a factory blank unless
  called with `overwrite: true`. Blank is judged by content, not by name.
- Every write is logged to `~/.ltamp-mcp/history.jsonl` with the slot's
  previous contents; `undo` restores them.
- The connection closes after 15 seconds idle, so Fender Tone can use the amp
  in between. Only one app can hold the amp at a time.

The catalog of models and settings is learned from the presets on your amp;
no Fender content ships with this package.

## Setup

```sh
npm install
npm run build
```

Claude Code:

```sh
claude mcp add ltamp -- node /path/to/ltamp-mcp/dist/index.js
```

Claude Desktop and other clients (`claude_desktop_config.json` or equivalent):

```json
{
  "mcpServers": {
    "ltamp": { "command": "node", "args": ["/path/to/ltamp-mcp/dist/index.js"] }
  }
}
```

Set `LTAMP_MCP_HOME` to keep history and snapshots somewhere other than `~/.ltamp-mcp`.

## Development

```sh
npm test                 # unit tests, no amp needed
npm run smoke -- 42      # end-to-end through MCP on a real amp; 42 must be a blank slot
```

The smoke test saves a test tone into the given slot and undoes it, and
returns the amp to the slot it started on.
