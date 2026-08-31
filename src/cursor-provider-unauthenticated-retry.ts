import { CursorLiveRunAbortError } from "./cursor-live-run-coordinator.js";
import { classifyCursorConnectError } from "./cursor-provider-errors.js";
import { asRecord } from "./cursor-record-utils.js";

export const DEFAULT_CURSOR_UNAUTHENTICATED_RETRY_DELAYS_MS = [5_000, 15_000, 30_000] as const;

const SOFT_RETRY_CURSOR_AUTH_CODES = new Set([
	"unauthenticated",
	"unauthorized",
	"not_logged_in",
	"auth_token_not_found",
	"auth_token_expired",
]);

let retryDelaysMs: readonly number[] = DEFAULT_CURSOR_UNAUTHENTICATED_RETRY_DELAYS_MS;

export function getCursorUnauthenticatedRetryDelaysMs(): readonly number[] {
	return retryDelaysMs;
}

export function setCursorUnauthenticatedRetryDelaysMsForTests(delays: readonly number[] | undefined): void {
	retryDelaysMs = delays ?? DEFAULT_CURSOR_UNAUTHENTICATED_RETRY_DELAYS_MS;
}

export class CursorUnauthenticatedRetryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CursorUnauthenticatedRetryError";
	}
}

export function isTransientCursorUnauthenticatedMessage(message: string | undefined): boolean {
	return Boolean(message && /\[unauthenticated\]/i.test(message));
}

function getCursorSdkAuthenticationRetryLimit(error: unknown): number {
	const record = asRecord(error);
	if (!record) return 0;
	const name = error instanceof Error ? error.name : typeof record.name === "string" ? record.name : record.kind;
	if (name !== "AuthenticationError") return 0;
	if (record.isRetryable === true) return Number.POSITIVE_INFINITY;
	return typeof record.code === "string" && SOFT_RETRY_CURSOR_AUTH_CODES.has(record.code.toLowerCase()) ? 1 : 0;
}

export function getCursorUnauthenticatedRetryLimit(error: unknown): number {
	if (error instanceof CursorUnauthenticatedRetryError) return Number.POSITIVE_INFINITY;
	// ConnectError cause wins: SDK convertConnectError maps code 16 to AuthenticationError({ isRetryable: false, cause }).
	if (classifyCursorConnectError(error)?.kind === "unauthenticated") return Number.POSITIVE_INFINITY;
	const sdkRetryLimit = getCursorSdkAuthenticationRetryLimit(error);
	if (sdkRetryLimit > 0) return sdkRetryLimit;
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
	return isTransientCursorUnauthenticatedMessage(message) ? Number.POSITIVE_INFINITY : 0;
}

export async function waitForCursorUnauthenticatedRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) throw new CursorLiveRunAbortError();
	if (delayMs <= 0) return;
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, delayMs);
		timer.unref?.();
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(new CursorLiveRunAbortError());
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
