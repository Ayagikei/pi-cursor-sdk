import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { truncateCursorDisplayLine } from "./cursor-display-text.js";
import { getCursorSessionFile } from "./cursor-session-scope.js";
import { scrubSensitiveText } from "./cursor-sensitive-text.js";
import {
	getCursorReplayCallSummary,
	getCursorToolActivityTitle,
	normalizeCursorToolName,
} from "./cursor-tool-presentation-registry.js";
import { isCursorReplaySourceToolName } from "./cursor-replay-source-names.js";
import { getToolArgs, getToolName } from "./cursor-transcript-utils.js";
import { classifyCursorToolVisibility } from "./cursor-tool-visibility.js";

export const CURSOR_ACTIVITY_LOG_ENV = "PI_CURSOR_ACTIVITY_LOG";
export const CURSOR_ACTIVITY_LOG_FILENAME = "cursor-activity.jsonl";
export const CURSOR_ACTIVITY_LOG_VERSION = 1 as const;

export type CursorActivityEventType = "cursor.tool.started" | "cursor.tool.completed";

export interface CursorActivityRecord {
	version: typeof CURSOR_ACTIVITY_LOG_VERSION;
	type: CursorActivityEventType;
	ts: string;
	tool: string;
	title: string;
	summary: string;
	mutates: boolean;
	identity?: string;
}

const MUTATING_CURSOR_TOOLS = new Set(["edit", "write", "delete"]);
const MAX_SEEN_IDENTITIES = 8192;
const seenIdentities = new Set<string>();

export function resolveCursorActivityLogPath(
	env: Record<string, string | undefined> = process.env,
): string | undefined {
	const override = env[CURSOR_ACTIVITY_LOG_ENV]?.trim();
	if (override) return isAbsolute(override) ? override : resolve(override);
	const sessionFile = getCursorSessionFile();
	if (!sessionFile) return undefined;
	return join(dirname(sessionFile), CURSOR_ACTIVITY_LOG_FILENAME);
}

export function cursorActivityLogPathForSessionFile(sessionFile: string): string {
	return join(dirname(sessionFile), CURSOR_ACTIVITY_LOG_FILENAME);
}

function cursorActivityMutates(normalizedTool: string): boolean {
	return MUTATING_CURSOR_TOOLS.has(normalizedTool);
}

function activitySummary(toolName: string, args: Record<string, unknown>, apiKey?: string): string {
	const summary = (
		isCursorReplaySourceToolName(toolName)
			? getCursorReplayCallSummary(toolName, args as Parameters<typeof getCursorReplayCallSummary>[1])
			: undefined
	)
		?? (typeof args.path === "string" ? args.path : undefined)
		?? (typeof args.query === "string" ? args.query : undefined)
		?? (typeof args.command === "string" ? args.command : undefined)
		?? toolName;
	return truncateCursorDisplayLine(scrubSensitiveText(summary, apiKey), 160);
}

function dedupeKey(type: CursorActivityEventType, identity: string | undefined, tool: string, summary: string): string {
	return identity ? `${type}:${identity}` : `${type}:${tool}:${summary}`;
}

function rememberIdentity(key: string): boolean {
	if (seenIdentities.has(key)) return false;
	if (seenIdentities.size >= MAX_SEEN_IDENTITIES) {
		const oldest = seenIdentities.values().next().value;
		if (oldest !== undefined) seenIdentities.delete(oldest);
	}
	seenIdentities.add(key);
	return true;
}

export function buildCursorActivityRecord(
	toolCall: unknown,
	options: {
		type: CursorActivityEventType;
		identity?: string;
		apiKey?: string;
		ts?: string;
	},
): CursorActivityRecord | undefined {
	const visibility = classifyCursorToolVisibility(toolCall);
	const tool = visibility.normalizedName || normalizeCursorToolName(getToolName(toolCall));
	if (!tool || tool === "unknown") return undefined;
	const args = visibility.args ?? getToolArgs(toolCall);
	const title = truncateCursorDisplayLine(
		visibility.activityTitle ?? getCursorToolActivityTitle(tool),
		80,
	);
	const summary = activitySummary(tool, args, options.apiKey);
	return {
		version: CURSOR_ACTIVITY_LOG_VERSION,
		type: options.type,
		ts: options.ts ?? new Date().toISOString(),
		tool,
		title: title || tool,
		summary,
		mutates: cursorActivityMutates(tool),
		...(options.identity ? { identity: options.identity } : {}),
	};
}

export function formatCursorActivityOutputLine(record: CursorActivityRecord): string {
	const phase = record.type === "cursor.tool.started" ? "start" : "done";
	return `cursor ${phase} ${record.title}: ${record.summary}`;
}

export function appendCursorActivityRecord(
	record: CursorActivityRecord,
	env: Record<string, string | undefined> = process.env,
): boolean {
	const key = dedupeKey(record.type, record.identity, record.tool, record.summary);
	if (!rememberIdentity(key)) return false;
	const logPath = resolveCursorActivityLogPath(env);
	if (!logPath) return false;
	try {
		mkdirSync(dirname(logPath), { recursive: true });
		appendFileSync(logPath, `${JSON.stringify(record)}\n`);
		return true;
	} catch {
		return false;
	}
}

export function recordCursorToolActivity(
	toolCall: unknown,
	options: {
		type: CursorActivityEventType;
		identity?: string;
		apiKey?: string;
		env?: Record<string, string | undefined>;
	},
): boolean {
	const record = buildCursorActivityRecord(toolCall, options);
	if (!record) return false;
	return appendCursorActivityRecord(record, options.env);
}

export const __testUtils = {
	reset(): void {
		seenIdentities.clear();
	},
};
