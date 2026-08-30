import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	asMockCursorRun,
	collectEvents,
	getErrorEvent,
	makeContext,
	makeModel,
	mockCreatedAgent,
	resetCursorProviderTestState,
} from "./helpers/cursor-provider-harness.js";
import { streamCursor } from "../src/cursor-provider.js";
import { setCursorUnauthenticatedRetryDelaysMsForTests } from "../src/cursor-provider-unauthenticated-retry.js";

function makeFinishedRun() {
	return asMockCursorRun({
		id: "run-1",
		agentId: "agent-1",
		status: "finished",
		wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
	});
}

function makeUnauthenticatedConnectError(): Error & { rawMessage: string; code: number } {
	const error = new Error("[unauthenticated] Error") as Error & { rawMessage: string; code: number };
	error.name = "ConnectError";
	error.rawMessage = "Error";
	error.code = 16;
	error.stack =
		"ConnectError: [unauthenticated] Error\n" +
		"    at file:///repo/node_modules/@cursor/sdk/dist/esm/index.js:8:1086456";
	return error;
}

describe("Cursor provider onPayload", () => {
	beforeEach(resetCursorProviderTestState);

	it("sends the replacement payload returned by the Pi hook", async () => {
		const send = vi.fn().mockResolvedValue(makeFinishedRun());
		mockCreatedAgent({ send });
		const model = makeModel("gpt-5.5@1m");
		const onPayload = vi.fn(async (payload: unknown, hookModel: unknown) => {
			expect(payload).toEqual(expect.objectContaining({ text: expect.stringContaining("Hello") }));
			expect(hookModel).toBe(model);
			return { text: "masked prompt", images: [{ data: "masked-image", mimeType: "image/png" }] };
		});

		await collectEvents(streamCursor(model, makeContext(), { apiKey: "test-key", onPayload }));

		expect(onPayload).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenCalledWith(
			{ text: "masked prompt", images: [{ data: "masked-image", mimeType: "image/png" }] },
			expect.any(Object),
		);
	});

	it("keeps the original payload when the Pi hook returns undefined", async () => {
		const send = vi.fn().mockResolvedValue(makeFinishedRun());
		mockCreatedAgent({ send });
		const onPayload = vi.fn().mockResolvedValue(undefined);

		await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key", onPayload }));

		expect(onPayload).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ text: expect.stringContaining("Hello") }));
	});

	it("fails closed when the Pi hook returns a non-Cursor payload", async () => {
		const send = vi.fn().mockResolvedValue(makeFinishedRun());
		mockCreatedAgent({ send });

		const events = await collectEvents(streamCursor(makeModel(), makeContext(), {
			apiKey: "test-key",
			onPayload: () => ({ messages: [] }),
		}));

		expect(send).not.toHaveBeenCalled();
		expect(getErrorEvent(events).error.errorMessage).toContain("onPayload");
	});


	it("fails closed when the Pi hook throws", async () => {
		const send = vi.fn().mockResolvedValue(makeFinishedRun());
		mockCreatedAgent({ send });

		const events = await collectEvents(streamCursor(makeModel(), makeContext(), {
			apiKey: "test-key",
			onPayload: () => {
				throw new Error("hook failed");
			},
		}));

		expect(send).not.toHaveBeenCalled();
		expect(getErrorEvent(events).error.errorMessage).toContain("hook failed");
	});

	it("runs the Pi hook once when Cursor retries an unauthenticated send", async () => {
		setCursorUnauthenticatedRetryDelaysMsForTests([0, 0]);
		const send = vi.fn().mockResolvedValue(asMockCursorRun({
			id: "run-auth-retry",
			agentId: "agent-1",
			status: "running",
			wait: vi.fn().mockRejectedValue(makeUnauthenticatedConnectError()),
		}));
		mockCreatedAgent({ send });
		const onPayload = vi.fn((payload: unknown) => payload);

		await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key", onPayload }));

		expect(send).toHaveBeenCalledTimes(3);
		expect(onPayload).toHaveBeenCalledTimes(1);
	});
});
