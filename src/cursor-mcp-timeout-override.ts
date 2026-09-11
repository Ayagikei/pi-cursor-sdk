const CURSOR_SDK_MCP_DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_CURSOR_MCP_TOOL_TIMEOUT_MS = 3_600_000;
const DEFAULT_CURSOR_MCP_CONNECT_TIMEOUT_MS = 10_000;
const MIN_CURSOR_MCP_CONNECT_TIMEOUT_MS = 1_000;
const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;
const CURSOR_SDK_NAL_STALL_FAIL_TIMEOUT_MS = 30_000;
const CURSOR_SDK_NAL_STALL_HEARTBEAT_ONLY_TIMEOUT_MS = 90_000;
const CURSOR_SDK_NAL_STALL_HOLD_POLL_MS = 1_000;
const CURSOR_MCP_TOOL_TIMEOUT_MS_ENV = "PI_CURSOR_MCP_TOOL_TIMEOUT_MS";
const CURSOR_MCP_TOOL_TIMEOUT_SECONDS_ENV = "PI_CURSOR_MCP_TOOL_TIMEOUT_SECONDS";
const CURSOR_MCP_CONNECT_TIMEOUT_MS_ENV = "PI_CURSOR_MCP_CONNECT_TIMEOUT_MS";
const CURSOR_MCP_CONNECT_TIMEOUT_SECONDS_ENV = "PI_CURSOR_MCP_CONNECT_TIMEOUT_SECONDS";

interface CursorMcpToolTimeoutOverrideOptions {
	timeoutMs?: number;
	connectTimeoutMs?: number;
	env?: Record<string, string | undefined>;
}

interface CursorMcpToolTimeoutOverrideState {
	installed: boolean;
	timeoutMs: number;
	connectTimeoutMs: number;
	sdkDefaultTimeoutMs: number;
}

type GlobalSetTimeout = typeof globalThis.setTimeout;
type SetTimeoutHandler = Parameters<GlobalSetTimeout>[0];
type SetTimeoutDelay = Parameters<GlobalSetTimeout>[1];

let originalSetTimeout: GlobalSetTimeout | undefined;
let installedToolTimeoutMs = DEFAULT_CURSOR_MCP_TOOL_TIMEOUT_MS;
let installedConnectTimeoutMs = DEFAULT_CURSOR_MCP_CONNECT_TIMEOUT_MS;
let askQuestionStallHoldCount = 0;
let nalStallTimerHandlers = new WeakSet<object>();

function parsePositiveNumber(value: string | undefined): number | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	const parsed = Number(trimmed);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeOverrideTimeoutMs(timeoutMs: number): number {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return DEFAULT_CURSOR_MCP_TOOL_TIMEOUT_MS;
	return Math.min(Math.max(Math.trunc(timeoutMs), CURSOR_SDK_MCP_DEFAULT_TIMEOUT_MS), MAX_NODE_TIMER_DELAY_MS);
}

export function resolveCursorMcpToolTimeoutMs(
	env: Record<string, string | undefined> = process.env,
): number {
	const explicitMs = parsePositiveNumber(env[CURSOR_MCP_TOOL_TIMEOUT_MS_ENV]);
	if (explicitMs !== undefined) return normalizeOverrideTimeoutMs(explicitMs);

	const explicitSeconds = parsePositiveNumber(env[CURSOR_MCP_TOOL_TIMEOUT_SECONDS_ENV]);
	if (explicitSeconds !== undefined) return normalizeOverrideTimeoutMs(explicitSeconds * 1000);

	return DEFAULT_CURSOR_MCP_TOOL_TIMEOUT_MS;
}

function normalizeConnectTimeoutMs(timeoutMs: number): number {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return DEFAULT_CURSOR_MCP_CONNECT_TIMEOUT_MS;
	return Math.min(
		Math.max(Math.trunc(timeoutMs), MIN_CURSOR_MCP_CONNECT_TIMEOUT_MS),
		CURSOR_SDK_MCP_DEFAULT_TIMEOUT_MS,
	);
}

export function resolveCursorMcpConnectTimeoutMs(
	env: Record<string, string | undefined> = process.env,
): number {
	const explicitMs = parsePositiveNumber(env[CURSOR_MCP_CONNECT_TIMEOUT_MS_ENV]);
	if (explicitMs !== undefined) return normalizeConnectTimeoutMs(explicitMs);

	const explicitSeconds = parsePositiveNumber(env[CURSOR_MCP_CONNECT_TIMEOUT_SECONDS_ENV]);
	if (explicitSeconds !== undefined) return normalizeConnectTimeoutMs(explicitSeconds * 1000);

	return DEFAULT_CURSOR_MCP_CONNECT_TIMEOUT_MS;
}

function isCursorSdkMcpProtocolTimeoutStack(stack: string | undefined): boolean {
	if (!stack) return false;
	return (
		/(?:node_modules[/\\]@cursor[/\\]sdk|node_modules\/\@cursor\/sdk|@cursor\/sdk\/dist)/.test(stack) &&
		/\b_setupTimeout\b|\bProtocol\._setupTimeout\b/.test(stack)
	);
}

export function isCursorSdkMcpToolTimeoutStack(stack: string | undefined): boolean {
	if (!stack) return false;
	return (
		isCursorSdkMcpProtocolTimeoutStack(stack) &&
		/\bcallTool\b|\bClient\.callTool\b|\bMcpSdkClient\.callTool\b/.test(stack)
	);
}

export function isCursorSdkMcpConnectTimeoutStack(stack: string | undefined): boolean {
	if (!stack || !isCursorSdkMcpProtocolTimeoutStack(stack)) return false;
	return /\bClient\.(?:connect|listTools)\b|\bMcpSdkClient\.getTools\b/.test(stack);
}

export function setCursorAskQuestionStallHold(active: boolean): void {
	askQuestionStallHoldCount += active ? 1 : -1;
	if (askQuestionStallHoldCount < 0) askQuestionStallHoldCount = 0;
}

export function isCursorAskQuestionStallHoldActive(): boolean {
	return askQuestionStallHoldCount > 0;
}

export function isCursorSdkNalStallTimerStack(stack: string | undefined): boolean {
	if (!stack) return false;
	return (
		/(?:node_modules[/\\]@cursor[/\\]sdk|node_modules\/\@cursor\/sdk|@cursor\/sdk\/dist)/.test(stack) &&
		/\b(?:startTimer|startHeartbeatOnlyTimer)\b/.test(stack)
	);
}

function isCursorSdkDefaultMcpTimeout(delay: SetTimeoutDelay): boolean {
	return typeof delay === "number" && delay === CURSOR_SDK_MCP_DEFAULT_TIMEOUT_MS;
}

function isCursorSdkNalStallDiscoveryDelay(delay: SetTimeoutDelay): boolean {
	return (
		typeof delay === "number" &&
		(delay === CURSOR_SDK_NAL_STALL_FAIL_TIMEOUT_MS || delay === CURSOR_SDK_NAL_STALL_HEARTBEAT_ONLY_TIMEOUT_MS)
	);
}

function wrapNalStallTimerHandler(handler: SetTimeoutHandler): SetTimeoutHandler {
	if (typeof handler !== "function") return handler;
	const delegate = originalSetTimeout;
	if (!delegate) return handler;
	let skippedDuringHold = false;
	const wrapped = (...callbackArgs: unknown[]) => {
		if (isCursorAskQuestionStallHoldActive()) {
			skippedDuringHold = true;
			Reflect.apply(delegate, globalThis, [wrapped, CURSOR_SDK_NAL_STALL_HOLD_POLL_MS]);
			return;
		}
		if (skippedDuringHold) return;
		handler(...callbackArgs);
	};
	return wrapped as SetTimeoutHandler;
}

function patchedSetTimeout(
	handler: SetTimeoutHandler,
	delay?: SetTimeoutDelay,
	...args: unknown[]
): ReturnType<GlobalSetTimeout> {
	const delegate = originalSetTimeout;
	if (!delegate) throw new Error("Cursor MCP timeout override installed without original setTimeout");

	let nextHandler = handler;
	if (typeof nextHandler === "function" && nalStallTimerHandlers.has(nextHandler)) {
		nextHandler = wrapNalStallTimerHandler(nextHandler);
	}

	let nextDelay = delay;
	const needsStack = isCursorSdkDefaultMcpTimeout(delay) || isCursorSdkNalStallDiscoveryDelay(delay);
	if (needsStack) {
		const stack = new Error().stack;
		if (isCursorSdkDefaultMcpTimeout(delay)) {
			if (isCursorSdkMcpToolTimeoutStack(stack)) {
				nextDelay = installedToolTimeoutMs;
			} else if (isCursorSdkMcpConnectTimeoutStack(stack)) {
				nextDelay = installedConnectTimeoutMs;
			}
		}
		if (
			isCursorSdkNalStallDiscoveryDelay(delay) &&
			typeof handler === "function" &&
			isCursorSdkNalStallTimerStack(stack)
		) {
			nalStallTimerHandlers.add(handler);
			if (nextHandler === handler) nextHandler = wrapNalStallTimerHandler(handler);
		}
	}

	return Reflect.apply(delegate, globalThis, [nextHandler, nextDelay, ...args]) as ReturnType<GlobalSetTimeout>;
}

export function installCursorMcpToolTimeoutOverride(
	options: CursorMcpToolTimeoutOverrideOptions = {},
): CursorMcpToolTimeoutOverrideState {
	installedToolTimeoutMs = normalizeOverrideTimeoutMs(
		options.timeoutMs ?? resolveCursorMcpToolTimeoutMs(options.env),
	);
	installedConnectTimeoutMs = normalizeConnectTimeoutMs(
		options.connectTimeoutMs ?? resolveCursorMcpConnectTimeoutMs(options.env),
	);

	if (!originalSetTimeout) {
		originalSetTimeout = globalThis.setTimeout;
		globalThis.setTimeout = patchedSetTimeout as GlobalSetTimeout;
	}

	return {
		installed: true,
		timeoutMs: installedToolTimeoutMs,
		connectTimeoutMs: installedConnectTimeoutMs,
		sdkDefaultTimeoutMs: CURSOR_SDK_MCP_DEFAULT_TIMEOUT_MS,
	};
}

export function restoreCursorMcpToolTimeoutOverride(): void {
	if (originalSetTimeout) {
		globalThis.setTimeout = originalSetTimeout;
		originalSetTimeout = undefined;
	}
	installedToolTimeoutMs = DEFAULT_CURSOR_MCP_TOOL_TIMEOUT_MS;
	installedConnectTimeoutMs = DEFAULT_CURSOR_MCP_CONNECT_TIMEOUT_MS;
	askQuestionStallHoldCount = 0;
	nalStallTimerHandlers = new WeakSet<object>();
}

export const cursorMcpToolTimeoutOverrideDefaults = {
	cursorSdkDefaultTimeoutMs: CURSOR_SDK_MCP_DEFAULT_TIMEOUT_MS,
	defaultOverrideTimeoutMs: DEFAULT_CURSOR_MCP_TOOL_TIMEOUT_MS,
	defaultConnectTimeoutMs: DEFAULT_CURSOR_MCP_CONNECT_TIMEOUT_MS,
	minConnectTimeoutMs: MIN_CURSOR_MCP_CONNECT_TIMEOUT_MS,
	maxNodeTimerDelayMs: MAX_NODE_TIMER_DELAY_MS,
	timeoutMsEnv: CURSOR_MCP_TOOL_TIMEOUT_MS_ENV,
	timeoutSecondsEnv: CURSOR_MCP_TOOL_TIMEOUT_SECONDS_ENV,
	connectTimeoutMsEnv: CURSOR_MCP_CONNECT_TIMEOUT_MS_ENV,
	connectTimeoutSecondsEnv: CURSOR_MCP_CONNECT_TIMEOUT_SECONDS_ENV,
	nalStallFailTimeoutMs: CURSOR_SDK_NAL_STALL_FAIL_TIMEOUT_MS,
	nalStallHeartbeatOnlyTimeoutMs: CURSOR_SDK_NAL_STALL_HEARTBEAT_ONLY_TIMEOUT_MS,
	nalStallHoldPollMs: CURSOR_SDK_NAL_STALL_HOLD_POLL_MS,
} as const;
