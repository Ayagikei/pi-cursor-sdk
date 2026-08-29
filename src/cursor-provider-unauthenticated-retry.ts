import { CursorLiveRunAbortError } from "./cursor-live-run-coordinator.js";
import { classifyCursorConnectError } from "./cursor-provider-errors.js";

export const DEFAULT_CURSOR_UNAUTHENTICATED_RETRY_DELAYS_MS = [5_000, 15_000, 30_000] as const;

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

export function isTransientCursorUnauthenticatedError(error: unknown): boolean {
	if (error instanceof CursorUnauthenticatedRetryError) return true;
	if (classifyCursorConnectError(error)?.kind === "unauthenticated") return true;
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
	return isTransientCursorUnauthenticatedMessage(message);
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
