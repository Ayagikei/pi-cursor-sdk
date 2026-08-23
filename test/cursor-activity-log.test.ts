import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	__testUtils as activityLogTestUtils,
	appendCursorActivityRecord,
	buildCursorActivityRecord,
	CURSOR_ACTIVITY_LOG_ENV,
	cursorActivityLogPathForSessionFile,
	formatCursorActivityOutputLine,
	recordCursorToolActivity,
	resolveCursorActivityLogPath,
} from "../src/cursor-activity-log.js";
import { __testUtils as sessionScopeTestUtils } from "../src/cursor-session-scope.js";

describe("cursor activity log", () => {
	afterEach(() => {
		activityLogTestUtils.reset();
		sessionScopeTestUtils.reset();
		delete process.env[CURSOR_ACTIVITY_LOG_ENV];
	});

	it("prefers PI_CURSOR_ACTIVITY_LOG over the session sibling path", () => {
		const dir = mkdtempSync(join(tmpdir(), "cursor-activity-"));
		try {
			sessionScopeTestUtils.set(dir, join(dir, "session.jsonl"));
			process.env[CURSOR_ACTIVITY_LOG_ENV] = join(dir, "override.jsonl");
			expect(resolveCursorActivityLogPath()).toBe(join(dir, "override.jsonl"));
			expect(cursorActivityLogPathForSessionFile(join(dir, "session.jsonl"))).toBe(join(dir, "cursor-activity.jsonl"));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("writes a scrubbed completed edit without file contents", () => {
		const dir = mkdtempSync(join(tmpdir(), "cursor-activity-"));
		const logPath = join(dir, "cursor-activity.jsonl");
		try {
			process.env[CURSOR_ACTIVITY_LOG_ENV] = logPath;
			const written = recordCursorToolActivity({
				name: "StrReplace",
				args: { path: "src/foo.ts", old_string: "secret sk-test-1234567890abcdef", new_string: "ok" },
			}, { type: "cursor.tool.completed", identity: "cursor-tool:1" });
			expect(written).toBe(true);
			expect(recordCursorToolActivity({
				name: "StrReplace",
				args: { path: "src/foo.ts" },
			}, { type: "cursor.tool.completed", identity: "cursor-tool:1" })).toBe(false);

			const lines = readFileSync(logPath, "utf8").trim().split("\n");
			expect(lines).toHaveLength(1);
			const record = JSON.parse(lines[0]!);
			expect(record).toMatchObject({
				version: 1,
				type: "cursor.tool.completed",
				tool: "edit",
				mutates: true,
				identity: "cursor-tool:1",
			});
			expect(record.summary).toContain("src/foo.ts");
			expect(JSON.stringify(record)).not.toContain("sk-test-");
			expect(formatCursorActivityOutputLine(record)).toMatch(/^cursor done /);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not write when no session file or env path is configured", () => {
		const record = buildCursorActivityRecord({ name: "read", args: { path: "README.md" } }, { type: "cursor.tool.completed" });
		expect(record?.mutates).toBe(false);
		expect(appendCursorActivityRecord(record!)).toBe(false);
	});
});
