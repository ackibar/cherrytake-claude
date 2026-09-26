# CherryTake for Claude

Ask Claude to remove silent pauses from your Adobe Premiere Pro edit. This plugin connects Claude to the
[CherryTake](https://cherrytake.com) panel running inside Premiere Pro on your Mac: Claude can check the open
sequence, analyze its silences at one of five cut strengths, show you what would be removed, cut them and undo
the cut. Every cut is made on a new copy of the sequence, so your original sequence is never changed.

## Requirements

- macOS with Adobe Premiere Pro
- The CherryTake panel installed and open in Premiere Pro (Window > Extensions > CherryTake Core).
  CherryTake includes a 7-day free trial; after that, silence cutting needs a CherryTake plan.
  Claude uses the same licence as the panel and cannot unlock anything the panel has not.
- Claude running on the same Mac (Claude Code, or Claude Desktop with the `.mcpb` extension)

## Tools

| Tool | What it does | Changes your project? |
|---|---|---|
| `premiere_status` | Reports whether the panel is open, the active sequence, the cut strength, and whether an analysis or undo is available | No |
| `analyze_silences` | Finds silent pauses (strength 1 Very gentle – 5 Very tight; whole sequence, selected clips or In/Out range) and reports how many seconds would be cut | No |
| `cut_silences` | Cuts the silences from the last analysis on a new copy of the sequence (ripple, lift or markers only) | Yes – adds a sequence; Claude asks before every call |
| `undo_last_cut` | Reopens the original sequence. The cut copy stays in the project; nothing is deleted | Yes – changes the active sequence; Claude asks first |

Example: "Check my Premiere sequence and tell me how much the silences add up to at a gentle strength."

## How it works

The plugin starts a small Node.js MCP server from this folder (`src/sunucu.cjs`, no dependencies). The server
does not open any network connection. It passes each command to the CherryTake panel by writing a small JSON
file into a local folder, `~/Library/Application Support/CherryTake/bus/`, and reads the panel's reply from the
same folder. Command files are deleted as soon as they are read. The panel then runs the same code as its own
buttons.

## Privacy Policy

This plugin runs entirely on your Mac. It sends nothing to CherryTake's servers or to any other service, and it
never reads or sends your video, audio or project files. What it returns to Claude – the active sequence name,
the cut strength, the number and total length of the silences found, and the panel's status – becomes part of
your conversation with Claude and is handled by Anthropic under your agreement with Anthropic. The plugin keeps
no records of its own; diagnostic messages go only to the local MCP log of your Claude app.

The full CherryTake privacy policy, including the "CherryTake for Claude" paragraph in section 5, is at
<https://cherrytake.com/privacy>.

## Support

Email [support@cherrytake.com](mailto:support@cherrytake.com) or visit <https://cherrytake.com>.

## License

MIT – see [LICENSE](LICENSE).
