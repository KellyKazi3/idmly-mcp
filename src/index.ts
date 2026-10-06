#!/usr/bin/env node
// idmly MCP server (stdio). One job: hand a self-contained HTML design to the
// idmly engine and put the editable InDesign file (.idml, plus Links/ when the
// design has images) on disk where the agent can use it.
//
//   IDMLY_LICENSE_KEY   optional. Without it the engine runs the free trial
//                       (first pages only) and the tool result says how to buy.
//   IDMLY_ENGINE_URL    optional override (default: the hosted engine).
//   IDMLY_OUT_DIR       optional default output directory (default: next to the
//                       source file, or the current directory for inline HTML).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { promises as fs, constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { unzip, type ZipEntry } from "./unzip.js";

const { version: VERSION } = createRequire(import.meta.url)("../package.json") as { version: string };
const ENGINE = (process.env.IDMLY_ENGINE_URL || "https://idmly-production.up.railway.app").replace(/\/+$/, "");
const LICENSE_KEY = (process.env.IDMLY_LICENSE_KEY || "").trim();
const OUT_DIR_DEFAULT = (process.env.IDMLY_OUT_DIR || "").trim();
const PRICING_URL = "https://www.idmly.com/#pricing";
// Node's fetch (undici) gives up on a silent server after ~5 minutes on its
// own; the explicit timer keeps the message honest rather than extending it.
const CONVERT_TIMEOUT_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// License instance: the engine activates a key on first use and returns an
// instance id the client must echo on later calls (X-Idmly-Instance). Kept in
// ~/.idmly/instances.json keyed by a hash of the key, so the key itself is
// never written to disk by this tool. A process-lifetime memo means a
// read-only HOME costs one warning, never a lost conversion.
// ---------------------------------------------------------------------------
const STATE_DIR = path.join(os.homedir(), ".idmly");
const STATE_FILE = path.join(STATE_DIR, "instances.json");
const memo = new Map<string, string>();

function keyId(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

async function readInstanceFile(): Promise<Record<string, string>> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    return {};
  }
}

async function loadInstance(key: string): Promise<string> {
  if (!key) return "";
  const id = keyId(key);
  const cached = memo.get(id);
  if (cached !== undefined) return cached;
  const inst = (await readInstanceFile())[id] || "";
  memo.set(id, inst);
  return inst;
}

/** Persist a fresh activation. Returns an error message when the file could not be written. */
async function saveInstance(key: string, instance: string): Promise<string | null> {
  if (!key || !instance) return null;
  const id = keyId(key);
  if (memo.get(id) === instance) return null; // the engine echoes the same id on every licensed call
  memo.set(id, instance);
  try {
    const map = await readInstanceFile();
    map[id] = instance;
    await fs.mkdir(STATE_DIR, { recursive: true });
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(map, null, 2) + "\n", { mode: 0o600 });
    await fs.rename(tmp, STATE_FILE);
    return null;
  } catch (e) {
    const msg = `could not persist the license activation to ${STATE_FILE}: ${describeError(e)}`;
    console.error(`idmly-mcp: ${msg}`); // stderr only: stdout is the JSON-RPC channel
    return msg;
  }
}

/** Forget a stored activation Creem no longer accepts, so the next call activates afresh. */
async function dropInstance(key: string): Promise<void> {
  const id = keyId(key);
  memo.delete(id);
  try {
    const map = await readInstanceFile();
    if (!(id in map)) return;
    delete map[id];
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(map, null, 2) + "\n", { mode: 0o600 });
    await fs.rename(tmp, STATE_FILE);
  } catch (e) {
    console.error(`idmly-mcp: could not update ${STATE_FILE}: ${describeError(e)}`);
  }
}

// font-family strings come straight from the design and are printed into the
// agent's context: keep only things shaped like font names
const FONT_NAME_OK = /^[\p{L}\p{N} .+&'()_-]{1,60}$/u;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function describeError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const c = (e as Error & { cause?: unknown }).cause;
  if (c instanceof Error) {
    const code = (c as NodeJS.ErrnoException).code;
    return `${e.message} (${code ? String(code) : c.message})`;
  }
  return e.message;
}

function userAgent(platform?: string): string {
  // the engine reads the platform to pick glyph-fallback fonts the opening
  // machine already has; default to the machine this tool runs on.
  const p = platform || (process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : "");
  const tag = p === "win" ? "Windows NT 10.0" : p === "mac" ? "Macintosh" : "X11; Linux";
  return `idmly-mcp/${VERSION} (${tag})`;
}

/** Create a fresh directory, suffixing -2, -3… on collision (exclusive create, no race). */
async function claimDir(base: string): Promise<string> {
  for (let i = 0; i < 1000; i++) {
    const cand = i === 0 ? base : `${base}-${i + 1}`;
    try { await fs.mkdir(cand); return cand; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  }
  throw new Error(`could not find a free folder name for ${base}`);
}

/** Write a new file, suffixing -2, -3… on collision (exclusive create, no race). */
async function writeUnique(dir: string, stem: string, ext: string, data: Buffer): Promise<string> {
  for (let i = 0; i < 1000; i++) {
    const cand = path.join(dir, i === 0 ? `${stem}${ext}` : `${stem}-${i + 1}${ext}`);
    try { await fs.writeFile(cand, data, { flag: "wx" }); return cand; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  }
  throw new Error(`could not find a free filename for ${stem}${ext}`);
}

function safeStem(name: string): string {
  // no path separators, no leading dots (so ".." can never become a path
  // segment), bounded length; letters in any script survive
  const s = name.normalize("NFC").slice(0, 80)
    .replace(/\.(html?|idml|zip)$/i, "")
    .replace(/[^\p{L}\p{N}\p{M}_.-]+/gu, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  return s || "design";
}

/** Resolve a zip entry inside `root`; null when it would escape (zip-slip). */
function insideRoot(root: string, rel: string): string | null {
  const dest = path.resolve(root, rel);
  const within = path.relative(root, dest);
  if (!within || within === ".." || within.startsWith(".." + path.sep) || path.isAbsolute(within)) return null;
  return dest;
}

interface EngineError { status: number; detail: string; capped: boolean; retryAfter: number | null }

async function engineError(res: Response): Promise<EngineError> {
  let detail = "";
  try {
    const j = await res.json() as { detail?: unknown };
    detail = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail ?? j);
  } catch {
    detail = `engine returned HTTP ${res.status}`;
  }
  const ra = res.headers.get("retry-after");
  return {
    status: res.status, detail,
    capped: res.headers.get("x-idmly-trial-capped") === "1",
    retryAfter: ra && /^\d+$/.test(ra) ? parseInt(ra, 10) : null,
  };
}

function buyNote(): string {
  return `A $49 lifetime license covers the website and this MCP tool, unlimited full-document conversions. ` +
    `Details: ${PRICING_URL} · Checkout: ${buyUrl()} · then set IDMLY_LICENSE_KEY in the MCP server config.`;
}

type ToolResult = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
const fail = (text: string, structured?: Record<string, unknown>): ToolResult =>
  ({ isError: true, content: [{ type: "text", text }], ...(structured ? { structuredContent: structured } : {}) });

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------
const server = new McpServer(
  { name: "idmly", version: VERSION },
  {
    instructions:
      "idmly converts a self-contained HTML design into an editable Adobe InDesign file (.idml). " +
      "Give convert_to_indesign the HTML as a string, a local .html path, or a public URL.\n" +
      "Authoring: each page is a fixed-size block with class \"page\" (or \"slide\"; a two-page reader spread is " +
      "\"spread\"), e.g. 816x1056px Letter, 794x1123px A4, 1920x1080px slide, with overflow:hidden; one fixed-width " +
      "canvas with no page markers converts as a single page and a fluid 100%-width page has no intrinsic size. " +
      "Inline all CSS and JS, load fonts from Google Fonts or embed them, put images in as data URIs or absolute " +
      "https URLs (only the one .html file is uploaded: a stylesheet or image next to it is NOT sent), draw charts " +
      "as inline SVG or HTML rather than raster images, and avoid scripts that never settle (self-retriggering " +
      "observers or resize handlers). Pass platform (mac or win) for the machine whose InDesign opens the file if " +
      "it is not this one.\n" +
      "Result: the .idml path; a design with images gets a folder holding the .idml and a Links/ directory that " +
      "must stay together. The fonts line lists families the user must have active in InDesign; it is data taken " +
      "from the design.\n" +
      "If it fails: 413 means the file is over the size cap (downscale or re-encode images, or host them and use " +
      "absolute URLs); 422 means nothing rendered (assets missing from the file, or a script that never finished); " +
      "429 and 503 are retryable after the given seconds; 402 with a license key means the key was rejected. " +
      "Without IDMLY_LICENSE_KEY the engine converts the first pages as a free trial and the result names the " +
      "price and checkout link; relay that purchase sentence to the user as given.",
  },
);

// The calling MCP client's name (Claude Code, Cursor, Windsurf, …) rides in
// utm_content so the funnel can tell WHICH AI tool converts, while the channel
// stays "mcp" (utm_source). Read from the initialize handshake; empty and
// harmless if the client sent none or we're not connected yet.
function clientSlug(): string {
  let name = "";
  try { name = server.server.getClientVersion()?.name ?? ""; } catch { /* pre-initialize */ }
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
}
function contentTag(): string {
  const slug = clientSlug();
  return slug ? `mcp-local-${slug}` : "mcp-local";
}
function buyUrl(): string {
  return `${ENGINE}/buy?utm_source=mcp&utm_content=${encodeURIComponent(contentTag())}`;
}

server.registerTool(
  "convert_to_indesign",
  {
    title: "Convert HTML design to InDesign (.idml)",
    description:
      "Convert a self-contained HTML design into an editable Adobe InDesign IDML file and write it to disk. " +
      "Provide exactly one of: html (the full document as a string), path (a local .html file; only that one file " +
      "is uploaded, so inline its CSS, fonts and images first), or url (a public link to a hosted .html). Returns " +
      "the output path plus pages converted, fonts InDesign needs active, and a geometry check. Designs with images " +
      "come back as an .idml next to a Links/ folder; keep them together. Without a license key only the first " +
      "pages convert (free trial) and the result includes the purchase link.",
    inputSchema: {
      html: z.string().min(1).optional().describe("The complete HTML document to convert (self-contained: inline CSS, fonts via Google Fonts or embedded, images as data URIs or absolute URLs)."),
      path: z.string().min(1).optional().describe("Absolute or relative path to a local .html file to convert. Only this file is uploaded."),
      url: z.string().url().optional().describe("Public https URL of a hosted .html design (a direct link, not a share or app link)."),
      out_dir: z.string().optional().describe("Directory to write the output into. Defaults to IDMLY_OUT_DIR, else the source file's directory, else the current directory."),
      name: z.string().optional().describe("Base name for the output (no extension). Defaults to the source file name or 'design'."),
      platform: z.enum(["mac", "win"]).optional().describe("Which platform's InDesign will open the file (picks glyph-fallback fonts). Defaults to this machine; unknown platforms get free Noto/Source Han fallbacks."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ html, path: srcPath, url, out_dir, name, platform }, extra): Promise<ToolResult> => {
    const modes = [html, srcPath, url].filter(Boolean).length;
    if (modes !== 1) return fail("Provide exactly one of html, path, or url.");

    // ---- gather the input
    let body: Buffer | null = null;
    let filename = "design.html";
    let srcDir = process.cwd();
    if (srcPath) {
      const abs = path.resolve(srcPath);
      let real: string;
      try { real = await fs.realpath(abs); }
      catch (e) { return fail(`Could not read ${abs}: ${describeError(e)}`); }
      // only .html/.htm ever leaves this machine (checked on the resolved file,
      // so a symlink cannot smuggle another file through)
      if (!/\.html?$/i.test(real)) return fail(`${abs} is not an .html file. convert_to_indesign only converts HTML designs.`);
      try { body = await fs.readFile(real); }
      catch (e) { return fail(`Could not read ${abs}: ${describeError(e)}`); }
      filename = path.basename(abs);
      srcDir = path.dirname(abs);
    } else if (html) {
      body = Buffer.from(html, "utf8");
    }
    const stem = safeStem(name || (url ? new URL(url).pathname.split("/").pop() || "design" : filename));
    const outDir = path.resolve(out_dir || OUT_DIR_DEFAULT || srcDir);

    // ---- make sure the result has somewhere to land BEFORE spending a render
    try {
      await fs.mkdir(outDir, { recursive: true });
      await fs.access(outDir, fsConstants.W_OK);
    } catch (e) {
      return fail(`Cannot write to ${outDir}: ${describeError(e)}. Pass out_dir (or set IDMLY_OUT_DIR) to a writable folder.`);
    }

    // ---- call the engine (once more with a fresh activation if a stored one was rejected)
    const send = async (instance: string): Promise<Response | ToolResult> => {
      const form = new FormData();
      if (url) form.append("url", url);
      else form.append("file", new Blob([new Uint8Array(body!)], { type: "text/html" }), filename);
      if (LICENSE_KEY) {
        form.append("license_key", LICENSE_KEY);
        form.append("instance_id", instance);
      }
      form.append("utm_source", "mcp");
      form.append("utm_content", contentTag());
      const ctl = new AbortController();
      const abort = () => ctl.abort();
      extra.signal.addEventListener("abort", abort, { once: true });     // client cancelled the call
      const timer = setTimeout(abort, CONVERT_TIMEOUT_MS);
      try {
        return await fetch(`${ENGINE}/convert`, {
          method: "POST", body: form, headers: { "User-Agent": userAgent(platform) }, signal: ctl.signal,
        });
      } catch (e) {
        const code = (e as Error & { cause?: { code?: string } }).cause?.code;
        const timedOut = (e as Error).name === "AbortError" || code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT";
        if (extra.signal.aborted) return fail("The conversion was cancelled.");
        return fail(timedOut
          ? `The conversion did not finish within ${CONVERT_TIMEOUT_MS / 60000} minutes. Very large designs may need the hosted endpoint or a smaller file.`
          : `Could not reach the idmly engine at ${ENGINE}: ${describeError(e)}. A sleeping engine wakes in ~20 s; try again.`);
      } finally {
        clearTimeout(timer);
        extra.signal.removeEventListener("abort", abort);
      }
    };
    let instance = LICENSE_KEY ? await loadInstance(LICENSE_KEY) : "";
    let sent = await send(instance);
    if (sent instanceof Response && sent.status === 402 && LICENSE_KEY && instance) {
      // the stored activation was rejected (key reset, device cap, deactivated):
      // forget it and let the engine activate once more, as the website does
      await dropInstance(LICENSE_KEY);
      instance = "";
      sent = await send("");
    }
    if (!(sent instanceof Response)) return sent;
    const res = sent;

    if (!res.ok) {
      const err = await engineError(res);
      const lines = [`idmly could not convert this design (HTTP ${err.status}): ${err.detail}`];
      const structured: Record<string, unknown> = { status: err.status, detail: err.detail };
      if (err.status === 429 || err.status === 503) {
        structured.retryable = true;
        if (err.retryAfter !== null) structured.retry_after_seconds = err.retryAfter;
      }
      if (err.status === 402) {
        lines.push(LICENSE_KEY ? "The configured IDMLY_LICENSE_KEY was not accepted." : buyNote());
        structured.trial_capped = err.capped;
        structured.pricing_url = PRICING_URL;
        structured.buy_url = buyUrl();
      }
      return fail(lines.join("\n"), structured);
    }

    // ---- read the output; never write files for a cancelled request
    const data = Buffer.from(await res.arrayBuffer());
    if (extra.signal.aborted) return fail("The conversion was cancelled.");
    const warnings: string[] = [];
    const inst = res.headers.get("x-idmly-instance");
    if (inst && LICENSE_KEY) {
      const problem = await saveInstance(LICENSE_KEY, inst);
      if (problem) warnings.push(`Warning: ${problem}. Each run may activate the license again until HOME is writable.`);
    }

    // ---- write the output
    const h = (k: string) => res.headers.get(k) || "";
    const truncated = !!h("x-idmly-trial");
    const outStem = truncated ? `${stem}-trial` : stem;      // matches the site's converted-trial.* naming
    const isZip = (res.headers.get("content-type") || "").includes("zip");
    const files: string[] = [];
    let idmlPath: string;
    if (isZip) {
      // idml + Links/: unpack side by side so InDesign re-finds every link.
      // Parse first so an unreadable archive touches nothing on disk.
      let entries: ZipEntry[];
      try {
        entries = unzip(data);
        if (!entries.some(e => e.name === "converted.idml")) throw new Error("bundle is missing converted.idml");
      } catch (e) {
        const raw = await writeUnique(outDir, outStem, ".zip", data);
        return fail(`Converted, but the bundle could not be unpacked (${describeError(e)}). The raw bundle was saved to ${raw}; unzip it manually.`, { output: raw, format: "zip" });
      }
      const folder = await claimDir(path.join(outDir, outStem));
      idmlPath = path.join(folder, `${outStem}.idml`);
      for (const entry of entries) {
        const rel = entry.name === "converted.idml" ? `${outStem}.idml` : entry.name;
        const dest = insideRoot(folder, rel);
        if (!dest) continue;                                  // zip-slip: never leave the folder
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, entry.data);
        files.push(dest);
      }
    } else {
      idmlPath = await writeUnique(outDir, outStem, ".idml", data);
      files.push(idmlPath);
    }

    // ---- report
    const pages = parseInt(h("x-idmly-pages") || "0", 10);
    const pagesTotal = parseInt(h("x-idmly-pages-total") || String(pages), 10);
    const trial = h("x-idmly-keyless") === "1";
    const rawFonts = h("x-idmly-fonts").split(",").map(s => s.trim()).filter(Boolean);
    const fonts = rawFonts.filter(f => FONT_NAME_OK.test(f)).slice(0, 40);
    const fontsDropped = rawFonts.length - fonts.length;
    const geometry = h("x-idmly-geometry") || "ok";
    const images = parseInt(h("x-idmly-images") || "0", 10);
    const notice = h("x-idmly-notice");

    const lines: string[] = [];
    lines.push(truncated
      ? `Converted ${pages} of ${pagesTotal} pages (free trial) → ${idmlPath}`
      : `Converted ${pages} page${pages === 1 ? "" : "s"} → ${idmlPath}`);
    if (isZip) lines.push(`Images (${images} placement${images === 1 ? "" : "s"}) are linked from the Links/ folder beside the .idml; move them together.`);
    if (fonts.length) lines.push(`Fonts InDesign needs active (names taken from the design): ${fonts.join(", ")}. If headings look scrambled, two versions of a family are active at once; keep one.`);
    if (fontsDropped) lines.push(`${fontsDropped} font name${fontsDropped === 1 ? "" : "s"} omitted (unusual characters).`);
    if (geometry !== "ok") lines.push("Geometry check: drift (some frames may sit slightly off; compare against the HTML).");
    if (notice) lines.push(notice);
    if (truncated) lines.push(`The remaining ${pagesTotal - pages} page${pagesTotal - pages === 1 ? "" : "s"} were held back. ${buyNote()}`);
    else if (trial) lines.push(`Free trial conversion. ${buyNote()}`);
    lines.push(...warnings);

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: {
        output: idmlPath,
        files,
        format: isZip ? "idml+links" : "idml",
        pages, pages_total: pagesTotal,
        trial, truncated,
        fonts, geometry, images,
        ...(notice ? { notice } : {}),
        ...(trial ? { pricing_url: PRICING_URL, buy_url: buyUrl() } : {}),
        ...(warnings.length ? { warnings } : {}),
      },
    };
  },
);

async function probeHealth(): Promise<{ ok: true; rev: string | null } | { ok: false; reason: string }> {
  try {
    const r = await fetch(`${ENGINE}/health`, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) return { ok: false, reason: `HTTP ${r.status}` };
    const j: unknown = await r.json();
    const rev = typeof j === "object" && j !== null && "rev" in j && typeof (j as { rev: unknown }).rev === "string" ? (j as { rev: string }).rev : null;
    return { ok: true, rev };
  } catch (e) {
    return { ok: false, reason: describeError(e) };
  }
}

server.registerTool(
  "idmly_status",
  {
    title: "idmly status",
    description: "Check that the idmly engine is reachable and whether a license key is configured for this MCP server (presence only; the key is validated on conversion).",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (): Promise<ToolResult> => {
    const health = await probeHealth();
    const instance = LICENSE_KEY ? await loadInstance(LICENSE_KEY) : "";
    const text = [
      `Engine: ${ENGINE} — ${health.ok ? `reachable (rev ${health.rev ?? "?"})` : `NOT reachable (${health.reason}); a sleeping engine wakes in ~20 s, try again`}`,
      LICENSE_KEY
        ? `License key: configured (…${LICENSE_KEY.slice(-4)}), ${instance ? "activated on this machine" : "not yet activated (happens on first conversion)"}`
        : `License key: none — conversions run as the free trial (first pages only). ${buyNote()}`,
      `Default output: ${OUT_DIR_DEFAULT || "next to the source file (or the current directory)"}`,
    ].join("\n");
    return {
      content: [{ type: "text", text }],
      structuredContent: {
        engine: ENGINE, reachable: health.ok, rev: health.ok ? health.rev : null,
        ...(health.ok ? {} : { reason: health.reason }),
        license_key_present: !!LICENSE_KEY, activated: !!instance, version: VERSION,
      },
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
// The client owns this process: when it closes our stdin we are done. Exit
// explicitly rather than waiting for every keep-alive socket and timer to
// drain, which is what left orphaned servers behind on Linux CI.
process.stdin.once("end", () => process.exit(0));
process.stdin.once("close", () => process.exit(0));
