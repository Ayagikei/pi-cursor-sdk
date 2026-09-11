import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	asMockCursorRun,
	collectEvents,
	getErrorEvent,
	makeContext,
	makeModel,
	mockCreatedAgent,
	asMockSdkAgent,
	mockedCreate,
	mockedResume,
	resetCursorProviderTestState,
} from "./helpers/cursor-provider-harness.js";
import { streamCursor } from "../src/cursor-provider.js";
import { CURSOR_LOCAL_AGENT_IDLE_MS } from "../src/cursor-session-agent.js";
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

	it("recreates an idle pooled agent with one onPayload and a bootstrap send", async () => {
		const firstDispose = vi.fn().mockResolvedValue(undefined);
		const send = vi.fn()
			.mockResolvedValueOnce(makeFinishedRun())
			.mockResolvedValueOnce(asMockCursorRun({
				id: "run-2",
				agentId: "agent-2",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-2", status: "finished" }),
			}));
		mockedCreate
			.mockResolvedValueOnce(asMockSdkAgent({
				agentId: "agent-1",
				send,
				[Symbol.asyncDispose]: firstDispose,
			}))
			.mockResolvedValueOnce(asMockSdkAgent({
				agentId: "agent-2",
				send,
				[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
			}));

		let nowMs = 1_000;
		const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
		try {
			const firstOnPayload = vi.fn((payload: unknown) => payload);
			const firstContext = makeContext();
			await collectEvents(streamCursor(makeModel(), firstContext, { apiKey: "test-key", onPayload: firstOnPayload }));

			expect(firstOnPayload).toHaveBeenCalledTimes(1);
			expect(mockedCreate).toHaveBeenCalledTimes(1);
			expect(send).toHaveBeenCalledTimes(1);
			expect((send.mock.calls[0]?.[0] as { text?: string }).text).toContain("Cursor SDK tool boundary:");
			expect(firstOnPayload.mock.calls[0]?.[0]).toEqual(send.mock.calls[0]?.[0]);

			nowMs = 1_000 + CURSOR_LOCAL_AGENT_IDLE_MS;
			const secondOnPayload = vi.fn((payload: unknown) => payload);
			const followUpContext = makeContext();
			followUpContext.messages = [
				...firstContext.messages,
				{
					role: "assistant",
					content: [{ type: "text", text: "Hi there." }],
					api: "cursor-sdk",
					provider: "cursor",
					model: "test-model",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "stop",
					timestamp: 2,
				},
				{ role: "user", content: "Follow up", timestamp: 3 },
			];
			await collectEvents(streamCursor(makeModel(), followUpContext, { apiKey: "test-key", onPayload: secondOnPayload }));

			expect(secondOnPayload).toHaveBeenCalledTimes(1);
			expect(mockedCreate).toHaveBeenCalledTimes(2);
			expect(mockedResume).not.toHaveBeenCalled();
			expect(firstDispose).toHaveBeenCalledTimes(1);
			expect(send).toHaveBeenCalledTimes(2);
			const secondPrompt = send.mock.calls[1]?.[0] as { text?: string };
			expect(secondPrompt.text).toContain("Cursor SDK tool boundary:");
			expect(secondPrompt.text).toContain("Follow up");
			expect(secondOnPayload.mock.calls[0]?.[0]).toEqual(send.mock.calls[1]?.[0]);
		} finally {
			nowSpy.mockRestore();
		}
	});
});
