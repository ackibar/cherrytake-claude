# CherryTake for Adobe Premiere Pro

Ask Claude to remove silent pauses from your Adobe Premiere Pro edit, or to place a client's revision notes on
the timeline. This plugin connects Claude to the [CherryTake](https://cherrytake.com) panel running inside
Premiere Pro on your Mac: Claude can check the open sequence, analyze its silences at one of five cut strengths,
show you what would be removed, cut them and undo the cut. Every cut is made on a new copy of the sequence, so
your original sequence is never changed.

Paste your client's notes as they came (email, WhatsApp export or a list; timecodes are optional) and Claude
shows where each note belongs, with the candidate places and the reason for each. Markers are added only for the
placements you confirm. A note CherryTake cannot place reliably is reported as "no place found" and left for
you; Claude never marks a guess.

## Requirements

- macOS with Adobe Premiere Pro
- The CherryTake panel installed and open in Premiere Pro (Window > Extensions > CherryTake Core).
  CherryTake includes a 7-day free trial; after that, using CherryTake from Claude needs a Pro or
  Studio plan (the Basic plan covers silence removal in the panel only). Claude uses the same licence
  as the panel and cannot unlock anything the panel has not.
- Claude running on the same Mac (Claude Code, or Claude Desktop with the `.mcpb` extension)

## Tools

| Tool | What it does | Changes your project? |
|---|---|---|
| `premiere_status` | Reports whether the panel is open, the active sequence, the cut strength, and whether an analysis or undo is available | No |
| `analyze_silences` | Finds silent pauses (strength 1 Very gentle – 5 Very tight; whole sequence, selected clips or In/Out range) and reports how many seconds would be cut | No |
| `cut_silences` | Cuts the silences from the last analysis on a new copy of the sequence (ripple, lift or markers only) | Yes – adds a sequence; Claude asks before every call |
| `undo_last_cut` | Reopens the original sequence. The cut copy stays in the project; nothing is deleted | Yes – changes the active sequence; Claude asks first |
| `propose_note_markers` | Finds where each revision note belongs, using the sequence's transcript, speakers, silences and music; returns candidates with timecodes, reasons and confidence | No |
| `place_note_markers` | Adds sequence markers for the note placements you confirmed (the panel's "Remove note markers" button removes them) | Yes – adds markers; Claude asks before every call |

Examples:

- "Check my Premiere sequence and tell me how much the silences add up to at a gentle strength."
- "Here are the client's notes, show me where they go: …" – notes need a transcript of the sequence, made
  once in CherryTake's Transcript mode.

## Installation

1. Install CherryTake from <https://cherrytake.com> and open the panel in Premiere Pro
   (Window > Extensions > CherryTake Core).
2. Add the connector to Claude on the same Mac:
   - **Claude Desktop:** download `cherrytake.mcpb` and double-click it (or drag it onto Claude Desktop's
     Settings > Extensions page), then click Install. Claude Desktop runs it with its built-in Node.js.
   - **Claude Code:** clone this repository and run
     `claude mcp add cherrytake -- node /path/to/cherrytake-claude/src/sunucu.cjs` (Node.js 18 or later).
     Once CherryTake is listed in the Claude plugin directory you can install the `cherrytake` plugin with
     `/plugin` instead.
3. Ask Claude "Is Premiere ready for CherryTake?" – it calls `premiere_status` and tells you what it sees,
   including whether your licence covers using CherryTake from Claude.

## How it works

The plugin starts a small Node.js MCP server from this folder (`src/sunucu.cjs`, no dependencies). The server
does not open any network connection. It passes each command to the CherryTake panel by writing a small JSON
file into a local folder, `~/Library/Application Support/CherryTake/bus/`, and reads the panel's reply from the
same folder. Command files are deleted as soon as they are read. The panel then runs the same code as its own
buttons.

## Privacy Policy

This plugin runs entirely on your Mac. It sends nothing to CherryTake's servers or to any other service, and it
never reads or sends your video, audio or project files. Note placement uses CherryTake's local matching engine
only; the panel's optional online AI step for unclear notes is not used by these tools. What the plugin returns
to Claude – the active sequence name, the cut strength, the number and total length of the silences found, the
panel's status and, for notes, each note with its candidate timecodes and the reasons (which can quote a few
words of the transcript) – becomes part of your conversation with Claude and is handled by Anthropic under your
agreement with Anthropic. The plugin keeps
no records of its own; diagnostic messages go only to the local MCP log of your Claude app.

The full CherryTake privacy policy, including the "CherryTake for Claude" paragraph in section 5, is at
<https://cherrytake.com/privacy>.

## Support

Email [support@cherrytake.com](mailto:support@cherrytake.com) or visit <https://cherrytake.com>.

## License

MIT – see [LICENSE](LICENSE).
