import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installCursorStripCoauthorHooks, registerCursorStripCoauthorHooks } from "../src/cursor-strip-coauthor.js";
import { createExtensionTestContext } from "./helpers/context-fixtures.js";
import { initTrackedGitRepo, runGit } from "./helpers/git-repo.js";
import type { ExtensionHandler, SessionStartEvent } from "@earendil-works/pi-coding-agent";

// Byte-for-byte legacy scripts captured from the reviewed implementation. Never execute them.
const LEGACY_COMMIT_MSG = [
	"#!/bin/sh", "# pi-cursor-sdk:strip-cursor-coauthor", "msg_file=$1",
	'[ -n "$msg_file" ] && [ -f "$msg_file" ] || exit 0',
	`if grep -E '^[[:space:]]*Co-authored-by:[[:space:]]*Cursor[[:space:]]*<[^>]+>[[:space:]]*$' "$msg_file" >/dev/null 2>&1; then`,
	'  tmp="${msg_file}.pi-cursor-sdk-strip"',
	`  grep -v -E '^[[:space:]]*Co-authored-by:[[:space:]]*Cursor[[:space:]]*<[^>]+>[[:space:]]*$' "$msg_file" > "$tmp" || true`,
	'  if [ -s "$tmp" ]; then', '    mv "$tmp" "$msg_file"', "  else", '    rm -f "$tmp"', "  fi", "fi", "exit 0", "",
].join("\n");
const LEGACY_POST_COMMIT = String.raw`#!/bin/sh
# pi-cursor-sdk:strip-cursor-coauthor
msg=$(git log -1 --format=%B)
echo "$msg" | grep -E '^[[:space:]]*Co-authored-by:[[:space:]]*Cursor[[:space:]]*<[^>]+>[[:space:]]*$' >/dev/null 2>&1 || exit 0
new=$(printf '%s' "$msg" | grep -v -E '^[[:space:]]*Co-authored-by:[[:space:]]*Cursor[[:space:]]*<[^>]+>[[:space:]]*$')
[ -n "$new" ] || exit 0
tree=$(git rev-parse 'HEAD^{tree}')
parents=""
for p in $(git rev-parse 'HEAD^@' 2>/dev/null); do
  parents="$parents -p $p"
done
GIT_AUTHOR_NAME=$(git log -1 --format=%an)
GIT_AUTHOR_EMAIL=$(git log -1 --format=%ae)
GIT_AUTHOR_DATE=$(git log -1 --format=%aD)
GIT_COMMITTER_NAME=$(git log -1 --format=%cn)
GIT_COMMITTER_EMAIL=$(git log -1 --format=%ce)
GIT_COMMITTER_DATE=$(git log -1 --format=%cD)
export GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_AUTHOR_DATE
export GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL GIT_COMMITTER_DATE
# shellcheck disable=SC2086
new_commit=$(printf '%s' "$new" | git commit-tree "$tree" $parents)
git update-ref HEAD "$new_commit"
exit 0
`;

const roots: string[] = [];
function temp(): string {
	const path = realpathSync(mkdtempSync(join(tmpdir(), "cursor-strip-")));
	roots.push(path);
	return path;
}
function repo(): string {
	const cwd = temp();
	initTrackedGitRepo(cwd);
	// Do not let a user's signing configuration or hook destination affect owned fixtures.
	runGit(cwd, ["config", "commit.gpgSign", "false"]);
	return cwd;
}
function hook(cwd: string, name = "prepare-commit-msg"): string { return join(cwd, ".git", "hooks", name); }
function apply(cwd: string, message: string): string {
	const file = join(cwd, ".git", "owned-message");
	writeFileSync(file, message, "latin1");
	execFileSync("sh", [hook(cwd), file], { cwd, stdio: "pipe" });
	return readFileSync(file).toString("latin1");
}
beforeEach(() => {
	vi.stubEnv("GIT_CONFIG_GLOBAL", devNull);
	vi.stubEnv("GIT_CONFIG_SYSTEM", devNull);
	vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
	vi.stubEnv("GIT_CONFIG_COUNT", "0");
});
afterEach(() => {
	vi.unstubAllEnvs();
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("owned prepare-commit-msg hook", { timeout: 20_000 }, () => {
	it("installs only prepare-commit-msg and is idempotent", () => {
		const cwd = repo();
		expect(installCursorStripCoauthorHooks(cwd)).toEqual(["prepare-commit-msg"]);
		const contents = readFileSync(hook(cwd));
		expect(installCursorStripCoauthorHooks(cwd)).toEqual(["prepare-commit-msg"]);
		expect(readFileSync(hook(cwd))).toEqual(contents);
		expect(existsSync(hook(cwd, "post-commit"))).toBe(false);
	});

	it.each(process.platform === "win32" ? ["missing"] : ["missing", "non-executable"])("leaves messages and actual Git commits intact when recorded Node is %s", (kind) => {
		const cwd = repo(); installCursorStripCoauthorHooks(cwd);
		const runtime = join(cwd, ".git", `owned-${kind}-node`);
		if (kind === "non-executable") writeFileSync(runtime, "#!/bin/sh\nexit 97\n", { mode: 0o600 });
		const recorded = process.platform === "win32" ? process.execPath.replace(/\\/g, "/") : process.execPath;
		const replacement = process.platform === "win32" ? runtime.replace(/\\/g, "/") : runtime;
		const contents = readFileSync(hook(cwd), "utf8");
		expect(contents).toContain(recorded);
		writeFileSync(hook(cwd), contents.replaceAll(recorded, replacement));
		const message = "subject\n\nCo-authored-by: Cursor <c@x>\nCo-authored-by: Ada <a@x>\n";
		expect(apply(cwd, message)).toBe(message);
		const before = runGit(cwd, ["reflog", "--format=%H"]).split("\n").length;
		runGit(cwd, ["commit", "--allow-empty", "--cleanup=verbatim", "--no-verify", "-F", join(cwd, ".git", "owned-message")]);
		const commit = execFileSync("git", ["cat-file", "commit", "HEAD"], { cwd });
		expect(commit.subarray(commit.indexOf("\n\n") + 2)).toEqual(Buffer.from(message));
		expect(runGit(cwd, ["reflog", "--format=%H"]).split("\n").length).toBe(before + 1);
		expect(readdirSync(join(cwd, ".git")).filter((name) => name.startsWith(".pi-cursor-message-"))).toEqual([]);
	});

	it("removes only case-insensitive Cursor trailers, preserving all other bytes", () => {
		const cwd = repo();
		installCursorStripCoauthorHooks(cwd);
		const prefix = "subject\r\n\r\nbody byte \xff\r\n\r\n\r\n";
		const human = "Co-authored-by: Ada <ada@example.com>\r\nSigned-off-by: Human <h@example.com>\r\n";
		expect(apply(cwd, prefix + "co-AUTHORED-by: cUrSoR <agent@cursor.com>\r\n" + human + "\r\n\r\n")).toBe(prefix + human + "\r\n\r\n");
	});

	it.each([
		"subject\n\nCo-authored-by: Cursor <agent@cursor.com>\nThis is a body example, not a trailer.\n",
		"subject\n\nHuman body\n\n\n",
		"subject\nCo-authored-by: Cursor <agent@cursor.com>\n",
	])("leaves body examples and unrelated whitespace unchanged: %j", (message) => {
		const cwd = repo(); installCursorStripCoauthorHooks(cwd);
		expect(apply(cwd, message)).toBe(message);
	});

	it.each(["#", ";"])("preserves original comment/footer bytes with core.commentChar=%s", (comment) => {
		const cwd = repo(); installCursorStripCoauthorHooks(cwd);
		runGit(cwd, ["config", "core.commentChar", comment]);
		const footer = `\r\n${comment} Git footer\r\n${comment} another line  \r\n`;
		expect(apply(cwd, "subject\r\n\r\nCo-authored-by: Cursor <c@x>\r\nCo-authored-by: Ada <a@x>\r\n" + footer)).toBe("subject\r\n\r\nCo-authored-by: Ada <a@x>\r\n" + footer);
	});

	it("removes folded Cursor trailers but not human continuations", () => {
		const cwd = repo(); installCursorStripCoauthorHooks(cwd);
		expect(apply(cwd, "subject\n\nCo-authored-by: Cursor <c@x>\n continuation\nCo-authored-by: Ada <a@x>\n human\n")).toBe("subject\n\nCo-authored-by: Ada <a@x>\n human\n");
	});

	it("preserves actual commit body bytes/examples and human trailers with verbatim cleanup", () => {
		const cwd = repo(); installCursorStripCoauthorHooks(cwd);
		runGit(cwd, ["config", "i18n.commitEncoding", "ISO-8859-1"]);
		const body = "subject\r\n\r\nBody byte \xff and example:\r\nCo-authored-by: Cursor <example@x>\r\nThis is explanatory prose.\r\n\r\n\r\n";
		const human = "Co-authored-by: Ada <a@x>\r\n\r\n";
		const file = join(cwd, ".git", "owned-raw-message");
		writeFileSync(file, body + "co-authored-by: cursor <c@x>\r\n" + human, "latin1");
		runGit(cwd, ["commit", "--allow-empty", "--cleanup=verbatim", "--no-verify", "-F", file]);
		const commit = execFileSync("git", ["cat-file", "commit", "HEAD"], { cwd });
		expect(commit.subarray(commit.indexOf("\n\n") + 2)).toEqual(Buffer.from(body + human, "latin1"));
	});

	it.each([false, true])("filters actual --no-verify commit (amend=%s) without extra ref updates", (amend) => {
		const cwd = repo(); installCursorStripCoauthorHooks(cwd);
		const before = runGit(cwd, ["reflog", "--format=%H"]).split("\n").length;
		runGit(cwd, ["commit", ...(amend ? ["--amend"] : ["--allow-empty"]), "--no-verify", "-m", "changed\n\nCo-authored-by: Cursor <c@x>\nCo-authored-by: Ada <a@x>"]);
		expect(runGit(cwd, ["log", "-1", "--format=%B"])).toBe("changed\n\nCo-authored-by: Ada <a@x>");
		expect(runGit(cwd, ["reflog", "--format=%H"]).split("\n").length).toBe(before + 1);
	});

	it("filters an existing trailer on --amend --no-edit --no-verify", () => {
		const cwd = repo();
		runGit(cwd, ["commit", "--allow-empty", "-m", "existing\n\nCo-authored-by: Cursor <c@x>"]);
		installCursorStripCoauthorHooks(cwd);
		runGit(cwd, ["commit", "--amend", "--allow-empty", "--no-edit", "--no-verify"]);
		expect(runGit(cwd, ["log", "-1", "--format=%B"])).toBe("existing");
	});

	it("filters pre-existing amend trailers before Git's editor/comment footer", () => {
		const cwd = repo();
		runGit(cwd, ["commit", "--allow-empty", "-m", "existing\n\nCo-authored-by: Cursor <c@x>"]);
		installCursorStripCoauthorHooks(cwd);
		runGit(cwd, ["-c", "core.editor=true", "commit", "--amend", "--allow-empty", "--no-verify"]);
		expect(runGit(cwd, ["log", "-1", "--format=%B"])).toBe("existing");
	});

	it("preserves SSH signatures, notes and the foreign post-rewrite mapping on amend", () => {
		const cwd = repo();
		const key = join(cwd, ".git", "owned-signing-key");
		execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key], { stdio: "pipe" });
		runGit(cwd, ["config", "gpg.format", "ssh"]);
		runGit(cwd, ["config", "user.signingKey", key]);
		runGit(cwd, ["config", "commit.gpgSign", "true"]);
		runGit(cwd, ["config", "notes.rewriteRef", "refs/notes/commits"]);
		const old = runGit(cwd, ["rev-parse", "HEAD"]);
		runGit(cwd, ["notes", "add", "-m", "owned-note"]);
		writeFileSync(hook(cwd, "post-rewrite"), '#!/bin/sh\ncat > "$(git rev-parse --git-path owned-rewrite)"\n', { mode: 0o755 });
		installCursorStripCoauthorHooks(cwd);
		runGit(cwd, ["commit", "--amend", "--no-verify", "-m", "signed\n\nCo-authored-by: Cursor <c@x>"]);
		const head = runGit(cwd, ["rev-parse", "HEAD"]);
		expect(runGit(cwd, ["cat-file", "commit", "HEAD"])).toContain("gpgsig -----BEGIN SSH SIGNATURE-----");
		const allowed = join(cwd, ".git", "owned-allowed-signers");
		writeFileSync(allowed, "test@example.com " + readFileSync(key + ".pub", "utf8"));
		runGit(cwd, ["-c", `gpg.ssh.allowedSignersFile=${allowed}`, "verify-commit", "HEAD"]);
		expect(runGit(cwd, ["notes", "show", "HEAD"])).toBe("owned-note");
		expect(readFileSync(join(cwd, ".git", "owned-rewrite"), "utf8")).toBe(`${old} ${head}\n`);
		expect(runGit(cwd, ["log", "-1", "--format=%B"])).toBe("signed");
	});

	it("uses only the normal common-directory hooks for a linked worktree", () => {
		const cwd = repo();
		const worktree = join(temp(), "owned-worktree");
		runGit(cwd, ["worktree", "add", "--detach", worktree]);
		expect(installCursorStripCoauthorHooks(worktree)).toEqual(["prepare-commit-msg"]);
		expect(existsSync(hook(cwd))).toBe(true);
		runGit(worktree, ["commit", "--allow-empty", "--no-verify", "-m", "worktree\n\nCo-authored-by: Cursor <c@x>"]);
		expect(runGit(worktree, ["log", "-1", "--format=%B"])).toBe("worktree");
	});

	it("does not overwrite foreign hooks, even ones mentioning our marker", () => {
		const cwd = repo();
		for (const name of ["prepare-commit-msg", "commit-msg", "post-commit"]) {
			writeFileSync(hook(cwd, name), "#!/bin/sh\n# pi-cursor-sdk:strip-cursor-coauthor\n# human customized\nexit 0\n", { mode: 0o755 });
		}
		const before = ["prepare-commit-msg", "commit-msg", "post-commit"].map((name) => readFileSync(hook(cwd, name)));
		expect(installCursorStripCoauthorHooks(cwd)).toEqual([]);
		["prepare-commit-msg", "commit-msg", "post-commit"].forEach((name, i) => expect(readFileSync(hook(cwd, name))).toEqual(before[i]));
	});

	it.each([false, true])("retires exact owned legacy hooks only (foreign prepare=%s)", (foreign) => {
		const cwd = repo();
		writeFileSync(hook(cwd, "commit-msg"), LEGACY_COMMIT_MSG, { mode: 0o755 });
		writeFileSync(hook(cwd, "post-commit"), LEGACY_POST_COMMIT, { mode: 0o755 });
		const human = "#!/bin/sh\n# human prepare hook\nexit 0\n";
		if (foreign) writeFileSync(hook(cwd), human, { mode: 0o755 });
		expect(installCursorStripCoauthorHooks(cwd)).toEqual(foreign ? [] : ["prepare-commit-msg"]);
		expect(existsSync(hook(cwd, "commit-msg"))).toBe(false);
		expect(existsSync(hook(cwd, "post-commit"))).toBe(false);
		if (foreign) expect(readFileSync(hook(cwd), "utf8")).toBe(human);
	});

	it("keeps foreign commit-msg and post-commit hooks working alongside the filter", () => {
		const cwd = repo();
		for (const name of ["commit-msg", "post-commit"]) writeFileSync(hook(cwd, name), `#!/bin/sh\necho ${name} >> "$(git rev-parse --git-path owned-hook-calls)"\n`, { mode: 0o755 });
		const before = ["commit-msg", "post-commit"].map((name) => readFileSync(hook(cwd, name)));
		expect(installCursorStripCoauthorHooks(cwd)).toEqual(["prepare-commit-msg"]);
		runGit(cwd, ["commit", "--allow-empty", "-m", "subject\n\nCo-authored-by: Cursor <c@x>"]);
		expect(readFileSync(join(cwd, ".git", "owned-hook-calls"), "utf8")).toBe("commit-msg\npost-commit\n");
		["commit-msg", "post-commit"].forEach((name, i) => expect(readFileSync(hook(cwd, name))).toEqual(before[i]));
	});

	it.each(["absolute", "relative", "global"])("declines %s core.hooksPath without writing there", (kind) => {
		const cwd = repo(); const outside = temp();
		const config = join(outside, "owned-global-config");
		if (kind === "global") writeFileSync(config, `[core]\n hooksPath = ${outside}\n`);
		else runGit(cwd, ["config", "core.hooksPath", kind === "relative" ? relative(cwd, outside) : outside]);
		const previous = process.env.GIT_CONFIG_GLOBAL;
		try {
			if (kind === "global") process.env.GIT_CONFIG_GLOBAL = config;
			expect(installCursorStripCoauthorHooks(cwd)).toEqual([]);
		} finally {
			if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previous;
		}
		expect(existsSync(join(outside, "prepare-commit-msg"))).toBe(false);
		expect(existsSync(hook(cwd))).toBe(false);
	});

	it.each(["hooks-dir", "git-dir", "dangling-dir", "file", "dangling-file", "legacy-file"])("declines symlinked %s without touching targets", (kind) => {
		const cwd = repo(); const outside = temp();
		const target = join(outside, "target");
		writeFileSync(target, "unchanged", { mode: 0o600 });
		if (kind === "hooks-dir" || kind === "dangling-dir") {
			rmSync(join(cwd, ".git", "hooks"), { recursive: true });
			symlinkSync(kind === "hooks-dir" ? outside : join(outside, "missing"), join(cwd, ".git", "hooks"), "dir");
		} else if (kind === "git-dir") {
			renameSync(join(cwd, ".git"), join(outside, "git"));
			symlinkSync(join(outside, "git"), join(cwd, ".git"), "dir");
		} else symlinkSync(kind === "dangling-file" ? join(outside, "missing") : target, hook(cwd, kind === "legacy-file" ? "post-commit" : "prepare-commit-msg"));
		expect(installCursorStripCoauthorHooks(cwd)).toEqual([]);
		expect(readFileSync(target, "utf8")).toBe("unchanged");
		expect(lstatSync(target).mode & 0o777).toBe(0o600);
		expect(existsSync(join(outside, "missing"))).toBe(false);
		expect(existsSync(join(outside, "prepare-commit-msg"))).toBe(false);
	});

	it("ignores predictable old temp symlinks and refuses symlinked messages", () => {
		const cwd = repo(); installCursorStripCoauthorHooks(cwd);
		const outside = join(temp(), "target"); writeFileSync(outside, "untouched");
		const message = join(cwd, ".git", "owned-message");
		symlinkSync(outside, message + ".pi-cursor-sdk-strip");
		expect(apply(cwd, "subject\n\nCo-authored-by: Cursor <c@x>\n")).toBe("subject\n\n");
		expect(readFileSync(outside, "utf8")).toBe("untouched");
		rmSync(message); symlinkSync(outside, message);
		expect(() => execFileSync("sh", [hook(cwd), message], { cwd, stdio: "pipe" })).toThrow();
		expect(readFileSync(outside, "utf8")).toBe("untouched");
	});

	it("does not unlink or truncate a colliding exclusive temp target", () => {
		const cwd = repo(); installCursorStripCoauthorHooks(cwd);
		// Force a random-name collision in this owned hook, retaining the production transformation.
		writeFileSync(hook(cwd), readFileSync(hook(cwd), "utf8").replace("crypto.randomBytes(16)", "Buffer.alloc(16)"));
		const target = join(temp(), "target"); writeFileSync(target, "unchanged");
		const collision = join(cwd, ".git", ".pi-cursor-message-" + "00".repeat(16));
		symlinkSync(target, collision);
		const message = join(cwd, ".git", "owned-message");
		const original = "subject\n\nCo-authored-by: Cursor <c@x>\n";
		writeFileSync(message, original);
		expect(() => execFileSync("sh", [hook(cwd), message], { cwd, stdio: "pipe" })).toThrow();
		expect(readFileSync(target, "utf8")).toBe("unchanged");
		expect(readFileSync(message, "utf8")).toBe(original);
		expect(lstatSync(collision).isSymbolicLink()).toBe(true);
	});

	it("cleans up only its own temp when the final rename fails", () => {
		const cwd = repo(); installCursorStripCoauthorHooks(cwd);
		writeFileSync(hook(cwd), readFileSync(hook(cwd), "utf8").replace("fs.renameSync(temporary, file);", "throw Error('owned injected rename failure');"));
		const message = join(cwd, ".git", "owned-message");
		const original = "subject\n\nCo-authored-by: Cursor <c@x>\n";
		writeFileSync(message, original);
		expect(() => execFileSync("sh", [hook(cwd), message], { cwd, stdio: "pipe" })).toThrow();
		expect(readFileSync(message, "utf8")).toBe(original);
		expect(readdirSync(join(cwd, ".git")).filter((name) => name.startsWith(".pi-cursor-message-"))).toEqual([]);
	});

	it("fails closed without modifying messages when filtering cannot finish", () => {
		const cwd = repo(); installCursorStripCoauthorHooks(cwd);
		const directory = join(cwd, ".git", "owned-directory"); mkdirSync(directory);
		expect(() => execFileSync("sh", [hook(cwd), directory], { cwd, stdio: "pipe" })).toThrow();
	});
});

describe("session trust boundary", { timeout: 20_000 }, () => {
	it("installs at session start only for an affirmatively trusted owned repo", async () => {
		const cwd = repo();
		let handler: ExtensionHandler<SessionStartEvent> | undefined;
		registerCursorStripCoauthorHooks({ on: (_event, fn) => { handler = fn; } });
		await handler!({ type: "session_start", reason: "startup" }, createExtensionTestContext({ cwd, isProjectTrusted: () => true }));
		expect(existsSync(hook(cwd))).toBe(true);
	});
	it.each([false, undefined])("requires affirmative trust (%s) before even reading cwd", async (trust) => {
		let handler: ExtensionHandler<SessionStartEvent> | undefined;
		registerCursorStripCoauthorHooks({ on: (_event, fn) => { handler = fn; } });
		const ctx = createExtensionTestContext();
		if (trust === undefined) delete (ctx as Partial<typeof ctx>).isProjectTrusted;
		else ctx.isProjectTrusted = () => false;
		const cwd = vi.fn(() => { throw new Error("must not inspect project"); });
		Object.defineProperty(ctx, "cwd", { get: cwd });
		await handler!({ type: "session_start", reason: "startup" }, ctx);
		expect(cwd).not.toHaveBeenCalled();
	});
});
