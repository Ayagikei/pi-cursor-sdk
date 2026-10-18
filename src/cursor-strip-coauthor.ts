import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { join, parse, resolve } from "node:path";
import type { ExtensionHandler, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { noFollowFlag, openExistingRegularFileNoFollow } from "./cursor-durable-fs.js";

export const CURSOR_STRIP_COAUTHOR_MARKER = "pi-cursor-sdk:strip-cursor-coauthor";

// Exact fingerprints, not a marker substring: customized/foreign hooks are never ours to delete.
const LEGACY_HOOK_HASHES: Readonly<Record<string, string>> = {
	"commit-msg": "c4f57e5f4a2da7911e13269c4322dd30cde571a26263e36577ac05b0c90d3b79",
	"post-commit": "59421ebf8757ca143c32f46f765b822ba27a26528b4dcc4a3663386f26fe4f67",
};

// Embedded, self-contained JavaScript: no dependency on extension files after uninstall.
// Pin Node rather than running an arbitrary executable supplied by a repository's PATH.
const FILTER = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
let input, output, temporary, temporaryIdentity;
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const directories = directory => {
  let current = path.parse(path.resolve(directory)).root;
  for (const part of path.resolve(directory).slice(current.length).split(/[\\/]/).filter(Boolean)) {
    current = path.join(current, part);
    if (!fs.lstatSync(current).isDirectory()) throw Error('unsafe message directory');
  }
};
try {
  const file = process.argv[2];
  directories(path.dirname(file));
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.nlink !== 1) throw Error('unsafe message');
  input = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  if (!same(before, fs.fstatSync(input)) || !same(before, fs.lstatSync(file))) throw Error('message changed');
  const original = fs.readFileSync(input);
  // Latin-1 is a reversible byte mapping; retain every non-removed byte, including CRLF.
  const lines = original.toString('latin1').match(/[^\n]*\n|[^\n]+$/g) || [];
  const text = line => line.replace(/\r?\n$/, '');
  // Let Git identify its own comment footer (including configured comment characters).
  // Use this cleaned view only for classification; output always comes from original bytes.
  const cleaned = execFileSync('git', ['stripspace', '--strip-comments'], { input: original, stdio: ['pipe', 'pipe', 'pipe'] }).toString('latin1');
  const logical = cleaned ? cleaned.replace(/\n$/, '').split('\n') : [];
  const indices = [];
  let position = 0;
  for (const line of logical) {
    while (position < lines.length && text(lines[position]).replace(/[ \t\r\v\f]+$/, '') !== line) position++;
    if (position === lines.length) throw Error('unexpected Git stripspace output');
    indices.push(position++);
  }
  const end = logical.length;
  let start = end;
  while (start && logical[start - 1] !== '') start--;
  // A trailer paragraph must follow a subject/body and contain only trailers/continuations.
  let valid = start > 0 && start < end;
  let trailer = false;
  const remove = new Set();
  let cursor = false;
  for (let i = start; i < end; i++) {
    const line = logical[i];
    if (/^[A-Za-z0-9-]+[ \t]*:/.test(line)) {
      trailer = true;
      cursor = /^Co-authored-by:[ \t]*Cursor[ \t]*<[^>\r\n]+>[ \t]*$/i.test(line);
    } else if (!/^[ \t]+\S/.test(line) || !trailer) {
      valid = false;
    }
    if (cursor) remove.add(indices[i]);
  }
  if (valid && remove.size) {
    const filtered = Buffer.from(lines.filter((_, i) => !remove.has(i)).join(''), 'latin1');
    const candidate = path.join(path.dirname(file), '.pi-cursor-message-' + crypto.randomBytes(16).toString('hex'));
    output = fs.openSync(candidate, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    temporary = candidate;
    temporaryIdentity = fs.fstatSync(output);
    fs.writeFileSync(output, filtered);
    fs.fsyncSync(output);
    directories(path.dirname(file));
    if (!same(temporaryIdentity, fs.lstatSync(temporary)) || !same(before, fs.lstatSync(file))) throw Error('message changed');
    fs.closeSync(output); output = undefined;
    fs.renameSync(temporary, file);
    temporary = undefined;
  }
} catch {
  console.error('pi-cursor-sdk: could not safely filter commit trailers; commit cancelled');
  process.exitCode = 1;
} finally {
  if (input !== undefined) fs.closeSync(input);
  if (output !== undefined) fs.closeSync(output);
  if (temporary !== undefined) {
    // Clean up only the entry created by our successful exclusive open.
    try { if (same(temporaryIdentity, fs.lstatSync(temporary))) fs.unlinkSync(temporary); } catch {}
  }
}
`;

function shellQuote(value: string): string { return `'${value.replace(/'/g, `'"'"'`)}'`; }

function hookContents(): string {
	const node = process.platform === "win32" ? process.execPath.replace(/\\/g, "/") : process.execPath;
	return `#!/bin/sh\n# ${CURSOR_STRIP_COAUTHOR_MARKER}\n# prepare-commit-msg v2; missing recorded Node skips filtering.\nnode=${shellQuote(node)}\n[ -f "$node" ] && [ -x "$node" ] || exit 0\nexec "$node" - "$1" <<'PI_CURSOR_FILTER'\n${FILTER}\nPI_CURSOR_FILTER\n`;
}

function sameFile(left: Stats, right: Stats): boolean { return left.dev === right.dev && left.ino === right.ino; }

function entry(path: string): Stats | undefined {
	try { return lstatSync(path); } catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function assertDirectories(path: string): void {
	const absolute = resolve(path);
	let current = parse(absolute).root;
	for (const part of absolute.slice(current.length).split(/[\\/]/).filter(Boolean)) {
		current = join(current, part);
		if (!lstatSync(current).isDirectory()) throw new Error("unsafe hooks directory");
	}
}

function readHook(path: string): { contents: Buffer; identity: Stats } | undefined {
	const stat = entry(path);
	if (!stat) return undefined;
	if (!stat.isFile() || stat.nlink !== 1) throw new Error("unsafe hook entry");
	const fd = openExistingRegularFileNoFollow(path, constants.O_RDONLY);
	try { return { contents: readFileSync(fd), identity: fstatSync(fd) }; } finally { closeSync(fd); }
}

/** Called only after affirmative project trust; never modifies refs or completed commits. */
export function installCursorStripCoauthorHooks(repoCwd: string): string[] {
	try {
		assertDirectories(repoCwd);
		const env = { ...process.env };
		for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete env[key];
		const git = (args: string[]) => execFileSync("git", args, {
			cwd: repoCwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000,
		}).replace(/\n$/, "");
		if (git(["rev-parse", "--is-inside-work-tree"]) !== "true") return [];
		// Honor user/global config when detecting overrides, but never install into any override.
		try { git(["config", "--get", "core.hooksPath"]); return []; } catch (error) {
			if ((error as { status?: number }).status !== 1) return [];
		}
		const common = resolve(repoCwd, git(["rev-parse", "--git-common-dir"]));
		assertDirectories(common);
		const hooks = join(common, "hooks");
		if (!entry(hooks)) mkdirSync(hooks, { mode: 0o755 });
		assertDirectories(hooks);
		const directory = lstatSync(hooks);
		const assertUnchanged = () => {
			assertDirectories(hooks);
			if (!sameFile(directory, lstatSync(hooks))) throw new Error("hooks directory changed");
		};
		const path = join(hooks, "prepare-commit-msg");
		const contents = hookContents();
		const existing = readHook(path);
		const legacy = Object.keys(LEGACY_HOOK_HASHES).map((name) => ({ name, hook: readHook(join(hooks, name)) }));
		let installed = existing?.contents.equals(Buffer.from(contents)) ?? false;
		if (!existing) {
			let fd: number | undefined;
			let owned: Stats | undefined;
			try {
				assertUnchanged();
				fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(), 0o600);
				owned = fstatSync(fd);
				writeFileSync(fd, contents);
				assertUnchanged();
				if (!sameFile(owned, lstatSync(path))) throw new Error("hook changed");
				fchmodSync(fd, 0o755);
				installed = true;
			} finally {
				if (fd !== undefined) closeSync(fd);
				if (!installed && owned && sameFile(owned, lstatSync(path))) unlinkSync(path);
			}
		}
		// Retire only byte-identical legacy hooks, including when a foreign prepare hook blocks us.
		for (const { name, hook } of legacy) {
			if (!hook || createHash("sha256").update(hook.contents).digest("hex") !== LEGACY_HOOK_HASHES[name]) continue;
			assertUnchanged();
			const oldPath = join(hooks, name);
			const current = readHook(oldPath);
			if (current && sameFile(hook.identity, current.identity) && current.contents.equals(hook.contents)) unlinkSync(oldPath);
		}
		return installed ? ["prepare-commit-msg"] : [];
	} catch {
		// Hook installation must never block a session or overwrite an unsafe/foreign entry.
		return [];
	}
}

interface CursorStripCoauthorExtensionApi {
	on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): void;
}

export function registerCursorStripCoauthorHooks(pi: CursorStripCoauthorExtensionApi): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.isProjectTrusted?.() !== true) return;
		installCursorStripCoauthorHooks(ctx.cwd);
	});
}
