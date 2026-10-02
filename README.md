# idmly-mcp

Convert a self-contained HTML design into an editable Adobe InDesign file (`.idml`) from the AI agent you already use. This is the [idmly](https://www.idmly.com) engine exposed as a Model Context Protocol server, so Claude Code, Cursor, Codex, Windsurf or Claude Desktop can hand a finished design straight to InDesign.

The first two pages of any design convert free, no key needed. A [$49 lifetime license](https://www.idmly.com/#pricing) unlocks unlimited full-document conversions and covers both the website and this tool.

## Install

Node 20 or newer. The server runs with `npx`, nothing to clone. Start without a key and the free trial just works.

**Claude Code**

```bash
claude mcp add idmly -- npx -y idmly-mcp
```

**Cursor, Windsurf, Claude Desktop** (`mcp.json` / `claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "idmly": { "command": "npx", "args": ["-y", "idmly-mcp"] }
  }
}
```

**Codex CLI** (`~/.codex/config.toml`)

```toml
[mcp_servers.idmly]
command = "npx"
args = ["-y", "idmly-mcp"]
```

**With a license**, add the key from your purchase email as an environment variable:

```bash
claude mcp add idmly -e IDMLY_LICENSE_KEY=<your key> -- npx -y idmly-mcp
```

```json
"env": { "IDMLY_LICENSE_KEY": "<your key>" }
```

```toml
env = { IDMLY_LICENSE_KEY = "<your key>" }
```

## Tools

### `convert_to_indesign`

Give it exactly one of:

| argument | what |
|---|---|
| `html` | the complete HTML document as a string |
| `path` | a local `.html` file (only this one file is uploaded) |
| `url` | a public https link to a hosted `.html` |

Optional: `out_dir` (where to write; defaults to the source file's folder, or the current directory), `name` (output base name), `platform` (`mac` or `win`, which InDesign will open the file; picks glyph-fallback fonts, defaults to this machine).

It writes `<name>.idml` and returns the path, pages converted, the fonts InDesign needs active, and a geometry check. A design with images comes back as a folder holding the `.idml` and a `Links/` directory; keep them together and InDesign finds every image. Trial output is named `<name>-trial.idml`.

### `idmly_status`

Reports whether the engine is reachable and whether a license key is configured (presence only; the key is validated on the first conversion).

## Writing HTML that converts well

- Each page is a fixed-size block with class `page` (or `slide`). A two-page reader spread is class `spread`. Typical sizes: 816×1056px Letter, 794×1123px A4, 1920×1080px slide, with `overflow: hidden`. A single fixed-width canvas with no markers converts as one page; a fluid `width: 100%` page has no intrinsic size.
- Keep the file self-contained: inline CSS and JS, fonts from Google Fonts or embedded, images as data URIs or absolute URLs. A stylesheet or image sitting next to the file is not uploaded.
- Draw charts as inline SVG or HTML rather than raster images, so they stay editable.
- Avoid scripts that never settle (a MutationObserver or resize handler that re-triggers itself). The engine renders the page once, measures it, and rebuilds it as InDesign frames.

Text becomes editable text frames with paragraph styles, tables stay tables, SVG and CSS shapes become vector objects.

### Text a designer can keep editing

How the text is marked up decides how many frames it lands in and what the paragraph styles carry.

- Consecutive paragraphs inside one box become **one text frame**, one paragraph each. Space them with `margin-top` or `margin-bottom`; it arrives as Space Before or Space After on the paragraph that carries the margin. An empty spacer paragraph (`<p>&nbsp;</p>`) keeps the frame whole too.
- `padding-left` is the left indent and `text-indent` the first-line indent, so `padding-left: 46pt; text-indent: -46pt` is a hanging indent.
- A real tab character (inside `white-space: pre` or `pre-wrap`) gets tab stops on the CSS grid: set `tab-size` as a length (`tab-size: 46pt`) to put the stop where you want it.
- A two-column list (contents, prices, credits) converts best as a `<table>`: it becomes a native InDesign table with a paragraph style per cell.
- Paragraph styles are named from the tag and the element's **first** class (`<p class="caption">` gives "Body · caption"). To name one outright, add `data-idml-style="Cover Dates"`.
- Boxes that hold one continuous text can be linked: give each the same `data-idml-thread="cv"` and they convert as one threaded story, frame to frame, in document order (or `data-idml-thread-order="1"`, `"2"`, ...). Every frame but the last is fixed at the size of its text, so an added line pushes text on to the next frame. If a box starts mid-paragraph, add `data-idml-thread-continues` and its first paragraph is joined to the last one of the box before. InDesign recomposes a threaded story, so a line can move across a frame boundary compared with the HTML.
- An inline `display: inline-block` element inside a paragraph is a box of its own and becomes its own frame. Use a plain `<span>` for a run that only changes font or colour.

## When it fails

| result | meaning | what to do |
|---|---|---|
| 402 without a key | the free trial is used up for this design or this hour | the result carries the price and checkout link |
| 402 with a key | the key was not accepted | check the key; if it worked before, delete `~/.idmly/instances.json` so the next call activates again |
| 413 | over the size cap (15 MB trial, 50 MB licensed) | downscale or re-encode images, or host them and use absolute URLs |
| 422 | nothing rendered, or a script never finished | inline the missing assets; remove the runaway script |
| 429 / 503 | rate limit, or the license service is unreachable | retry after `retry_after_seconds` |

Large designs can take a couple of minutes to render. Some clients cut tool calls at 60 seconds by default; raise your client's per-tool timeout (for example `MCP_TOOL_TIMEOUT` in Claude Code) for big documents.

## Environment

| variable | default | purpose |
|---|---|---|
| `IDMLY_LICENSE_KEY` | none (free trial) | your license key from idmly.com |
| `IDMLY_OUT_DIR` | next to the source | default output directory |
| `IDMLY_ENGINE_URL` | the hosted engine | override for a self-hosted engine |

The key is activated on first use. The activation id is kept in `~/.idmly/instances.json` under a hash of the key; the key itself is never written to disk by this tool. Each machine that runs the server uses one activation from the license's allowance.

## Hosted endpoint

If you would rather not run a local process, the engine also speaks MCP over Streamable HTTP:

```
https://idmly-production.up.railway.app/mcp
Authorization: Bearer <your key>      (omit the header for the free trial)
```

Because a remote tool cannot write to your disk, that endpoint returns a one-time download link instead of a file path: the file is deleted as soon as it is fetched, or after ten minutes unfetched. The same endpoint works with the OpenAI Responses API `mcp` tool and the Agents SDK.

Plain REST is `POST /convert` with a multipart `file` (or `url`), plus `license_key` and `instance_id`. The first licensed response carries an `X-Idmly-Instance` header; send that value back as `instance_id` on every later call, or each call activates a new device against the license. The response is the `.idml` itself, or `application/zip` (containing `converted.idml` and `Links/`) when the design has images.

## Privacy

Uploaded designs are deleted from the engine as soon as the converted file has been returned. On the hosted MCP endpoint the converted file waits behind a one-time, unguessable link for up to ten minutes so the agent can fetch it, then it is deleted. No accounts. The engine keeps a first-party usage ledger (counts, outcome, country), never your file or your key.

## Development

```bash
npm install
npm test          # type-checks, bundles, then runs the client against a stub engine (no network)
```

The published package has no runtime dependencies: `npm run build` bundles the
MCP SDK and zod into `dist/index.js`, so `npx` users get exactly the file the
tests ran against. Dependency updates arrive as a weekly Dependabot pull request;
merging it publishes a new patch version from GitHub Actions with provenance.

## License

MIT for this client. The idmly engine is a hosted service, see [idmly.com/legal](https://www.idmly.com/legal.html).
