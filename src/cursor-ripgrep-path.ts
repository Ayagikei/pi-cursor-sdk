import { accessSync, constants } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";

const RIPGREP_ENV = "CURSOR_RIPGREP_PATH";
const TREE_SITTER_VENDOR_ENV = "CURSOR_TREE_SITTER_VENDOR_DIR";

function resolveCursorSdkPlatformPackageDir(
	fromModuleUrl: string | URL = import.meta.url,
): string | undefined {
	try {
		const require = createRequire(fromModuleUrl);
		const platformPackage = `@cursor/sdk-${process.platform}-${process.arch}`;
		const sdkEntry = require.resolve("@cursor/sdk");
		return dirname(
			require.resolve(`${platformPackage}/package.json`, { paths: [dirname(sdkEntry)] }),
		);
	} catch {
		return undefined;
	}
}

export function resolveBundledCursorRipgrepPath(
	fromModuleUrl: string | URL = import.meta.url,
): string | undefined {
	try {
		const packageDirectory = resolveCursorSdkPlatformPackageDir(fromModuleUrl);
		if (!packageDirectory) return undefined;
		const ripgrepPath = join(packageDirectory, "bin", process.platform === "win32" ? "rg.exe" : "rg");
		accessSync(ripgrepPath, constants.X_OK);
		return ripgrepPath;
	} catch {
		return undefined;
	}
}

export function ensureCursorRipgrepPath(): string | undefined {
	const configuredPath = process.env[RIPGREP_ENV];
	if (configuredPath && isAbsolute(configuredPath)) return configuredPath;

	const bundledPath = resolveBundledCursorRipgrepPath();
	if (bundledPath) process.env[RIPGREP_ENV] = bundledPath;
	return bundledPath;
}

export function resolveBundledCursorTreeSitterVendorDir(
	fromModuleUrl: string | URL = import.meta.url,
): string | undefined {
	try {
		const packageDirectory = resolveCursorSdkPlatformPackageDir(fromModuleUrl);
		if (!packageDirectory) return undefined;
		const vendorDir = join(packageDirectory, "vendor");
		accessSync(join(vendorDir, "tree-sitter", "index.js"), constants.R_OK);
		accessSync(join(vendorDir, "tree-sitter-bash", "index.js"), constants.R_OK);
		return vendorDir;
	} catch {
		return undefined;
	}
}

export function ensureCursorTreeSitterVendorDir(): string | undefined {
	const configuredPath = process.env[TREE_SITTER_VENDOR_ENV];
	if (configuredPath && isAbsolute(configuredPath)) return configuredPath;

	const bundledPath = resolveBundledCursorTreeSitterVendorDir();
	if (bundledPath) process.env[TREE_SITTER_VENDOR_ENV] = bundledPath;
	return bundledPath;
}
