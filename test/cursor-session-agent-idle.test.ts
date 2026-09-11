import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeCursorContextFingerprint } from "../src/context.js";
import {
	acquireSessionCursorAgent,
	CURSOR_LOCAL_AGENT_IDLE_MS,
	planCursorSessionSend,
	__testUtils as sessionAgentTestUtils,
} from "../src/cursor-session-agent.js";
import { __testUtils as resumeTestUtils } from "../src/cursor-session-agent-resume.js";
import { __testUtils as cursorSessionScopeTestUtils } from "../src/cursor-session-scope.js";
import { makeContext } from "./helpers/pi-harness.js";
import { installCursorSessionStoreMock } from "./helpers/cursor-session-store.js";

describe("cursor-session-agent idle eviction", () => {
	let nowMs = 1_000;

	beforeEach(async () => {
		installCursorSessionStoreMock();
		cursorSessionScopeTestUtils.reset();
		resumeTestUtils.reset();
		await sessionAgentTestUtils.disposeAllSessionCursorAgents();
		vi.clearAllMocks();
		nowMs = 1_000;
		vi.spyOn(Date, "now").mockImplementation(() => nowMs);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function setNowMs(ms: number): void {
		nowMs = ms;
	}

	it("reuses a pooled agent last used inside the idle window", async () => {
		const createAgent = vi.fn().mockResolvedValue({
			agentId: "agent-1",
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/test.jsonl");
		const params = {
			apiKey: "test-key",
			agentMode: "agent" as const,
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent,
		};

		setNowMs(1_000);
		const first = await acquireSessionCursorAgent(params);
		const context = makeContext();
		first.commitSend(context, true);
		setNowMs(1_000 + CURSOR_LOCAL_AGENT_IDLE_MS - 1);
		const second = await acquireSessionCursorAgent(params);

		expect(second.created).toBe(false);
		expect(second.agent).toBe(first.agent);
		expect(createAgent).toHaveBeenCalledTimes(1);
		expect(planCursorSessionSend(second.sendState, context).mode).toBe("incremental");
	});

	it("creates a new agent after idle instead of resuming the previous one", async () => {
		const firstDispose = vi.fn().mockResolvedValue(undefined);
		const createAgent = vi
			.fn()
			.mockResolvedValueOnce({ agentId: "agent-1", [Symbol.asyncDispose]: firstDispose })
			.mockResolvedValueOnce({ agentId: "agent-2", [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined) });
		const resumeAgent = vi.fn();
		const scopeKey = "/tmp/sessions/test.jsonl";
		cursorSessionScopeTestUtils.set("/tmp/project", scopeKey);
		const params = {
			apiKey: "test-key",
			agentMode: "agent" as const,
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			localResume: true,
			createAgent,
			resumeAgent,
		};

		setNowMs(1_000);
		const first = await acquireSessionCursorAgent(params);
		const context = makeContext();
		first.commitSend(context, true);
		resumeTestUtils.set({
			scopeKey,
			sessionFile: scopeKey,
			cwd: "/tmp/project",
			activeHandle: {
				version: 2,
				runtime: "local",
				agentId: "agent-1",
				scopeKey,
				sessionFile: scopeKey,
				cwd: "/tmp/project",
				poolKey: first.poolKey,
				branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
				compactionGeneration: 0,
				sendState: {
					bootstrapped: true,
					contextFingerprint: computeCursorContextFingerprint(context),
					incrementalSendCount: 0,
				},
				createdAt: "2026-08-18T00:00:00.000Z",
			},
		});
		setNowMs(1_000 + CURSOR_LOCAL_AGENT_IDLE_MS);
		const second = await acquireSessionCursorAgent(params);

		expect(second.created).toBe(true);
		expect(second.resumed).toBeFalsy();
		expect(second.agent).not.toBe(first.agent);
		expect(createAgent).toHaveBeenCalledTimes(2);
		expect(resumeAgent).not.toHaveBeenCalled();
		expect(firstDispose).toHaveBeenCalledTimes(1);
		expect(planCursorSessionSend(second.sendState, context)).toEqual({
			mode: "bootstrap",
			resetAgent: false,
			reason: "initial",
		});
	});

	it("does not dispose a busy in-flight agent when the idle window elapses", async () => {
		const firstDispose = vi.fn().mockResolvedValue(undefined);
		const createAgent = vi.fn().mockResolvedValue({
			agentId: "agent-1",
			[Symbol.asyncDispose]: firstDispose,
		});
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/test.jsonl");
		const params = {
			apiKey: "test-key",
			agentMode: "agent" as const,
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent,
		};

		setNowMs(1_000);
		const first = await acquireSessionCursorAgent(params);
		first.commitSend(makeContext(), true);
		const completion = new Promise<void>(() => {
			// never resolves
		});
		first.trackRunCompletion(completion);

		setNowMs(1_000 + CURSOR_LOCAL_AGENT_IDLE_MS);
		const blockedAcquirePromise = acquireSessionCursorAgent(params);
		await Promise.resolve();

		expect(firstDispose).not.toHaveBeenCalled();
		expect(createAgent).toHaveBeenCalledTimes(1);
		expect(sessionAgentTestUtils.getSessionCursorAgentPoolState("/tmp/sessions/test.jsonl").status).toBe("busy");

		await sessionAgentTestUtils.disposeSessionCursorAgent("/tmp/sessions/test.jsonl");
		await expect(blockedAcquirePromise).rejects.toBeInstanceOf(sessionAgentTestUtils.SessionCursorAgentScopeClosedError);
		expect(firstDispose).toHaveBeenCalledTimes(1);
	});

	it("replaces an idle agent once for concurrent acquires and skips resume", async () => {
		const firstDispose = vi.fn().mockResolvedValue(undefined);
		const createAgent = vi
			.fn()
			.mockResolvedValueOnce({ agentId: "agent-1", [Symbol.asyncDispose]: firstDispose })
			.mockResolvedValueOnce({ agentId: "agent-2", [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined) });
		const resumeAgent = vi.fn();
		const scopeKey = "/tmp/sessions/test.jsonl";
		cursorSessionScopeTestUtils.set("/tmp/project", scopeKey);
		const params = {
			apiKey: "test-key",
			agentMode: "agent" as const,
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			localResume: true,
			createAgent,
			resumeAgent,
		};

		setNowMs(1_000);
		const first = await acquireSessionCursorAgent(params);
		const context = makeContext();
		first.commitSend(context, true);
		resumeTestUtils.set({
			scopeKey,
			sessionFile: scopeKey,
			cwd: "/tmp/project",
			activeHandle: {
				version: 2,
				runtime: "local",
				agentId: "agent-1",
				scopeKey,
				sessionFile: scopeKey,
				cwd: "/tmp/project",
				poolKey: first.poolKey,
				branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
				compactionGeneration: 0,
				sendState: {
					bootstrapped: true,
					contextFingerprint: computeCursorContextFingerprint(context),
					incrementalSendCount: 0,
				},
				createdAt: "2026-08-18T00:00:00.000Z",
			},
		});
		setNowMs(1_000 + CURSOR_LOCAL_AGENT_IDLE_MS);

		const [second, third] = await Promise.all([
			acquireSessionCursorAgent(params),
			acquireSessionCursorAgent(params),
		]);

		expect(second.agent).toBe(third.agent);
		expect(second.agent).not.toBe(first.agent);
		expect(second.resumed).toBeFalsy();
		expect(third.resumed).toBeFalsy();
		expect(createAgent).toHaveBeenCalledTimes(2);
		expect(resumeAgent).not.toHaveBeenCalled();
		expect(firstDispose).toHaveBeenCalledTimes(1);
		expect(planCursorSessionSend(second.sendState, context).mode).toBe("bootstrap");
	});
});
