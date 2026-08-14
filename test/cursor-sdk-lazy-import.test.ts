import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fingerprintApiKey, saveModelListCache } from "../src/model-list-cache.js";
import type { ModelListItem } from "@cursor/sdk";

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) return sourceFiles(path);
		return path.endsWith(".ts") ? [path] : [];
	});
}

function moduleText(node: ts.ImportDeclaration | ts.ExportDeclaration): string | undefined {
	return node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined;
}

function isTypeOnlyExport(node: ts.ExportDeclaration): boolean {
	return node.isTypeOnly || Boolean(node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.every((element) => element.isTypeOnly));
}

const PI_HOST_PEER_ROOTS = [
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"@sinclair/typebox",
	"typebox",
] as const;

function isPiHostPeer(specifier: string): boolean {
	return PI_HOST_PEER_ROOTS.some((root) => specifier === root || specifier.startsWith(`${root}/`));
}

function importHasRuntimeBindings(node: ts.ImportDeclaration): boolean {
	const clause = node.importClause;
	if (!clause) return true;
	if (clause.isTypeOnly) return false;
	if (clause.name || !clause.namedBindings || ts.isNamespaceImport(clause.namedBindings)) return true;
	return clause.namedBindings.elements.some((element) => !element.isTypeOnly);
}

function isCursorSdkSpecifier(specifier: string): boolean {
	return specifier === "@cursor/sdk" || specifier.startsWith("@cursor/sdk/");
}

function isAllowedCursorSdkDynamicImport(relativePath: string, specifier: string): boolean {
	return (
		(relativePath.endsWith("src/cursor-sdk-runtime.ts") && specifier === "@cursor/sdk")
		|| (relativePath.endsWith("src/cursor-session-store.ts") && specifier === "@cursor/sdk/sqlite")
	);
}

function collectRuntimeSdkEdges(paths: string[] = sourceFiles(join(process.cwd(), "src"))): string[] {
	const offenders: string[] = [];
	for (const path of paths) {
		const relativePath = relative(process.cwd(), path).replace(/\\/g, "/");
		const source = ts.createSourceFile(path, readFileSync(path, "utf-8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const visit = (node: ts.Node): void => {
			if (ts.isImportDeclaration(node) && importHasRuntimeBindings(node)) {
				const specifier = moduleText(node);
				if (specifier && isCursorSdkSpecifier(specifier)) {
					offenders.push(`${relativePath}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: runtime import ${specifier}`);
				}
				if (specifier?.startsWith("@modelcontextprotocol/sdk/") && !relativePath.endsWith("src/cursor-pi-tool-bridge-run.ts")) {
					offenders.push(`${relativePath}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: runtime import ${specifier}`);
				}
				if (specifier === "./cursor-pi-tool-bridge-run.js") {
					offenders.push(`${relativePath}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: runtime import bridge run implementation`);
				}
			}
			if (ts.isExportDeclaration(node) && !isTypeOnlyExport(node)) {
				const specifier = moduleText(node);
				if (specifier && isCursorSdkSpecifier(specifier)) {
					offenders.push(`${relativePath}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: runtime export ${specifier}`);
				}
				if (specifier?.startsWith("@modelcontextprotocol/sdk/")) {
					offenders.push(`${relativePath}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: runtime export ${specifier}`);
				}
			}
			if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
				const argument = node.arguments[0];
				if (argument && ts.isStringLiteralLike(argument)) {
					const specifier = argument.text;
					if (isCursorSdkSpecifier(specifier) && !isAllowedCursorSdkDynamicImport(relativePath, specifier)) {
						offenders.push(`${relativePath}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: dynamic import ${specifier} outside runtime loader`);
					}
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
	}
	return offenders;
}

type RuntimeModuleInfo = {
	path: string;
	relativePath: string;
	runtimeHostPeers: string[];
	staticRelativeSpecifiers: string[];
	dynamicImports: Array<{ line: number; specifier?: string }>;
};

function sharedRuntimeFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) return sharedRuntimeFiles(path);
		return path.endsWith(".mjs") ? [path] : [];
	});
}

function runtimeModuleFiles(
	srcDir: string = join(process.cwd(), "src"),
	sharedDir: string = join(process.cwd(), "shared"),
): string[] {
	return [...sourceFiles(srcDir), ...sharedRuntimeFiles(sharedDir)];
}

function resolveSourceSpecifier(importerPath: string, specifier: string, sourcePaths: ReadonlySet<string>): string | undefined {
	if (!specifier.startsWith(".")) return undefined;
	const resolved = resolve(dirname(importerPath), specifier);
	const candidates = [
		resolved.replace(/\.(?:c|m)?js$/, ".ts"),
		resolved,
		`${resolved}.ts`,
		join(resolved, "index.ts"),
	];
	return candidates.find((candidate) => sourcePaths.has(candidate));
}

function collectUnsafeHostPeerDynamicImports(paths: string[] = runtimeModuleFiles()): string[] {
	const sourcePaths = new Set(paths);
	const modules = new Map<string, RuntimeModuleInfo>();

	for (const path of paths) {
		const source = ts.createSourceFile(
			path,
			readFileSync(path, "utf-8"),
			ts.ScriptTarget.Latest,
			true,
			path.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS,
		);
		const info: RuntimeModuleInfo = {
			path,
			relativePath: relative(process.cwd(), path).replace(/\\/g, "/"),
			runtimeHostPeers: [],
			staticRelativeSpecifiers: [],
			dynamicImports: [],
		};
		const visit = (node: ts.Node): void => {
			if (ts.isImportDeclaration(node) && importHasRuntimeBindings(node)) {
				const specifier = moduleText(node);
				if (specifier && isPiHostPeer(specifier)) info.runtimeHostPeers.push(specifier);
				if (specifier?.startsWith(".")) info.staticRelativeSpecifiers.push(specifier);
			}
			if (ts.isExportDeclaration(node) && !isTypeOnlyExport(node)) {
				const specifier = moduleText(node);
				if (specifier && isPiHostPeer(specifier)) info.runtimeHostPeers.push(specifier);
				if (specifier?.startsWith(".")) info.staticRelativeSpecifiers.push(specifier);
			}
			if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
				const argument = node.arguments[0];
				info.dynamicImports.push({
					line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
					specifier: argument && ts.isStringLiteralLike(argument) ? argument.text : undefined,
				});
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
		modules.set(path, info);
	}

	const findHostPeer = (startPath: string): string | undefined => {
		const pending = [startPath];
		const visited = new Set<string>();
		while (pending.length > 0) {
			const path = pending.pop()!;
			if (visited.has(path)) continue;
			visited.add(path);
			const info = modules.get(path);
			if (!info) continue;
			if (info.runtimeHostPeers.length > 0) return `${info.relativePath} -> ${info.runtimeHostPeers[0]}`;
			for (const specifier of info.staticRelativeSpecifiers) {
				const target = resolveSourceSpecifier(path, specifier, sourcePaths);
				if (!target) return `${info.relativePath} -> unresolved static import ${specifier}`;
				pending.push(target);
			}
		}
		return undefined;
	};

	const offenders: string[] = [];
	for (const info of modules.values()) {
		for (const dynamicImport of info.dynamicImports) {
			if (!dynamicImport.specifier) {
				offenders.push(`${info.relativePath}:${dynamicImport.line}: non-literal dynamic import`);
				continue;
			}
			if (isPiHostPeer(dynamicImport.specifier)) {
				offenders.push(`${info.relativePath}:${dynamicImport.line}: dynamic import of host peer ${dynamicImport.specifier}`);
				continue;
			}
			const target = resolveSourceSpecifier(info.path, dynamicImport.specifier, sourcePaths);
			if (!target) {
				if (dynamicImport.specifier.startsWith(".")) {
					offenders.push(`${info.relativePath}:${dynamicImport.line}: unresolved relative dynamic import ${dynamicImport.specifier}`);
				}
				continue;
			}
			const hostPeer = findHostPeer(target);
			if (hostPeer) {
				offenders.push(`${info.relativePath}:${dynamicImport.line}: ${dynamicImport.specifier} reaches ${hostPeer}`);
			}
		}
	}
	return offenders.sort();
}

describe("Cursor SDK lazy runtime imports", () => {
	const originalEnv = process.env;
	let tmpAgentDir: string | undefined;

	afterEach(() => {
		if (tmpAgentDir) rmSync(tmpAgentDir, { recursive: true, force: true });
		tmpAgentDir = undefined;
		process.env = originalEnv;
		vi.doUnmock("@cursor/sdk");
		vi.resetModules();
	});

	it("keeps heavy SDK value imports behind lazy runtime boundaries", () => {
		expect(collectRuntimeSdkEdges()).toEqual([]);
	});

	it("rejects static SDK subpaths and template SDK imports outside the runtime loaders", () => {
		tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-cursor-sdk-sdk-edge-"));
		const fixturePath = join(tmpAgentDir, "sdk-edge.ts");
		writeFileSync(fixturePath, [
			'import { open } from "@cursor/sdk/sqlite";',
			"void import(`@cursor/sdk/experimental`);",
		].join("\n"));

		const findings = collectRuntimeSdkEdges([fixturePath]).join("\n");
		expect(findings).toContain("runtime import @cursor/sdk/sqlite");
		expect(findings).toContain("dynamic import @cursor/sdk/experimental outside runtime loader");
	});

	it("keeps native dynamic imports away from Pi host-peer subtrees", () => {
		expect(collectUnsafeHostPeerDynamicImports()).toEqual([]);
	});

	it("fails closed for host subpaths, template specifiers, nested shared modules, and unresolved edges", () => {
		tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-cursor-sdk-import-graph-"));
		const srcDir = join(tmpAgentDir, "src");
		const sharedDir = join(tmpAgentDir, "shared");
		const nestedSharedDir = join(sharedDir, "nested");
		mkdirSync(srcDir);
		mkdirSync(nestedSharedDir, { recursive: true });
		const entryPath = join(srcDir, "entry.ts");
		writeFileSync(entryPath, [
			'void import("@earendil-works/pi-ai/compat");',
			"void import(`../shared/peer.mjs`);",
			'void import("../shared/broken.mjs");',
			'const computed = "./safe.js";',
			"void import(computed);",
			'void import("./missing.js");',
		].join("\n"));
		writeFileSync(join(sharedDir, "peer.mjs"), 'export { Text } from "./nested/host.mjs";\n');
		writeFileSync(join(nestedSharedDir, "host.mjs"), 'import { Text } from "@earendil-works/pi-tui/components";\nexport { Text };\n');
		writeFileSync(join(sharedDir, "broken.mjs"), 'export { missing } from "./missing.mjs";\n');

		const findings = collectUnsafeHostPeerDynamicImports(runtimeModuleFiles(srcDir, sharedDir)).join("\n");
		expect(findings).toContain("dynamic import of host peer @earendil-works/pi-ai/compat");
		expect(findings).toContain("../shared/peer.mjs reaches");
		expect(findings).toContain("@earendil-works/pi-tui/components");
		expect(findings).toContain("../shared/broken.mjs reaches");
		expect(findings).toContain("unresolved static import ./missing.mjs");
		expect(findings).toContain("non-literal dynamic import");
		expect(findings).toContain("unresolved relative dynamic import ./missing.js");
	});

	it("serves a warm model catalog without evaluating @cursor/sdk", async () => {
		tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-cursor-sdk-lazy-import-"));
		process.env = { ...originalEnv, PI_CODING_AGENT_DIR: tmpAgentDir, CURSOR_API_KEY: "warm-cache-key" };
		const model: ModelListItem = {
			id: "composer-2",
			displayName: "Composer 2",
			variants: [{ params: [], displayName: "Composer 2", isDefault: true }],
		};
		expect(saveModelListCache(fingerprintApiKey("warm-cache-key"), [model])).toBe(true);
		vi.doMock("@cursor/sdk", () => {
			throw new Error("@cursor/sdk should not be evaluated on a warm cached discovery path");
		});

		const { discoverModels } = await import("../src/model-discovery.js");
		const models = await discoverModels();

		expect(models.map((entry) => entry.id)).toEqual(["composer-2"]);
	});

	it("loads the installed SDK checkpoint store without the old root sqlite dependency", async () => {
		tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-cursor-sdk-checkpoint-contract-"));
		const { loadCursorSdk } = await import("../src/cursor-sdk-runtime.js");
		const { createAgentPlatform } = await loadCursorSdk();

		const platform = await createAgentPlatform({ workspaceRef: tmpAgentDir, scopedWorkspaceRef: tmpAgentDir });
		const checkpoint = await platform.checkpointStore.loadLatest("pi-cursor-sdk-checkpoint-contract-test");

		expect(checkpoint).toBeNull();
	});
});
