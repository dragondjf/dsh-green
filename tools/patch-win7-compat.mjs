#!/usr/bin/env node
/**
 * dsh-green Win7 兼容补丁:让 dsh 0.1.7+ 的 dsh-app-boot 在 win7 兼容版 Node 上可启动。
 *
 * 背景:dsh-app-boot@0.1.7 起在 boot 主路径通过原生 addon(node-addon-require-builtin)
 * 探测并接管 Node 内部模块(internal/modules/esm/loader 等),实现插件依赖的运行时
 * 解析路由(单例化,避免多副本冲突)。该 addon 靠匹配 V8 GetCurrentContext 机器码
 * 序言定位内部 API,在 win7 兼容版 node v22.22.3(社区移植构建)上 ABI 不匹配,
 * 探测抛 Unsupported/no-context;boot 主路径对此无容错、无开关 -> 进程启动即崩。
 *
 * 补丁(对 bundle 产物做精确文本替换,幂等):
 *  1. internalModules(): 每个 addon.requireBuiltin 失败时回退普通 require
 *     (run.bat 已带 --expose-internals,内部模块可直接 require);仍失败则抛
 *     addon 原错误,保持错误语义。
 *  2. installRuntimeInterception(): internalModules() 抛错时不再让 boot 崩溃,
 *     而是返回 no-op 拦截对象——依赖解析回退到物理 node_modules 布局(单物理副本,
 *     与 0.1.5-rc.3 行为等价,由构建期 align/sync 保证)。
 *
 * 用法: node patch-win7-compat.mjs <搜索起点目录>
 *   递归查找起点下所有 dsh-app-boot 包(lib/index.js 存在)并打补丁,
 *   兼容 pnpm hoisted(顶层)与 npm(嵌套 dsh/node_modules)两种布局。
 * 退出码: 0 = 已补丁或无需补丁; 1 = 找到目标但替换失败(精确文本不匹配,通常是上游改版)。
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

const MARKER = "[dsh-green win7-compat]";
const BOOT_DIR_NAME = "dsh-app-boot";
const TARGETS = ["lib/index.js", "lib/worker/profile-resolution-bootstrap.js"];

// ---- 精确替换片段(与 0.1.7-rc.2 / 0.2.0-rc.2 bundle 逐字符对齐, tab 缩进; 两版均实测命中) ----

// A0. addon 加载失败容错(两文件文本一致): 包缺失时给出抛错 stub, 统一由 reqBuiltin 回退
const OLD_ADDON_LOAD = '\tconst addon = createRequire(import.meta.url)("node-addon-require-builtin");';
const NEW_ADDON_LOAD = [
	`\t/* ${MARKER} tolerate a missing addon entirely (stub rethrows inside reqBuiltin) */`,
	"\tlet addon;",
	"\ttry {",
	'\t\taddon = createRequire(import.meta.url)("node-addon-require-builtin");',
	"\t} catch (addonLoadError) {",
	'\t\taddon = { requireBuiltin() { throw addonLoadError; } };',
	"\t}"
].join("\n");

// A. internalModules(): requireBuiltin -> 带回退的 reqBuiltin(两文件文本一致)
const OLD_INTERNAL_MODULES = [
	'\tconst esmModule = addon.requireBuiltin("internal/modules/esm/loader");',
	'\tconst cjsModule = addon.requireBuiltin("internal/modules/cjs/loader");',
	'\tconst cjsHelpers = addon.requireBuiltin("internal/modules/helpers");',
	'\tconst esmUtils = addon.requireBuiltin("internal/modules/esm/utils");',
	'\tconst esmResolve = addon.requireBuiltin("internal/modules/esm/resolve");'
].join("\n");
const NEW_INTERNAL_MODULES = [
	`\t/* ${MARKER} native addon probe may fail on win7-compatible Node builds (V8 prologue ABI mismatch);`,
	"\t * fall back to plain require (available under --expose-internals) before re-raising. */",
	"\tconst reqBuiltin = (id) => {",
	"\t\ttry {",
	"\t\t\treturn addon.requireBuiltin(id);",
	"\t\t} catch (addonError) {",
	"\t\t\ttry {",
	"\t\t\t\treturn createRequire(import.meta.url)(id);",
	"\t\t\t} catch {",
	"\t\t\t\tthrow addonError;",
	"\t\t\t}",
	"\t\t}",
	"\t};",
	'\tconst esmModule = reqBuiltin("internal/modules/esm/loader");',
	'\tconst cjsModule = reqBuiltin("internal/modules/cjs/loader");',
	'\tconst cjsHelpers = reqBuiltin("internal/modules/helpers");',
	'\tconst esmUtils = reqBuiltin("internal/modules/esm/utils");',
	'\tconst esmResolve = reqBuiltin("internal/modules/esm/resolve");'
].join("\n");

// B. installRuntimeInterception() 开头: internalModules() 失败 -> no-op 拦截(两文件该段一致)
const OLD_INTERCEPTION = [
	"function installRuntimeInterception(resolution) {",
	"\tconst { esm, esmDefaultResolve, esmConditions, cjs, cjsConditions, modern } = internalModules();",
	"\tconst router = new ResolutionRouter(resolution, (directory) => cjs._nodeModulePaths(directory));"
].join("\n");

// no-op 拦截体: index.js 有 packageDirFromParent(物理查找, 与上游"未安装拦截"分支同语义);
// worker bootstrap 返回值被丢弃, packageDir 给空实现即可。
function noopBody(indexVariant) {
	const pkgDir = indexVariant
		? "\t\t\tpackageDir(specifier, parentURL) {\n\t\t\t\treturn packageDirFromParent(specifier, parentURL);\n\t\t\t},"
		: "\t\t\tpackageDir(specifier, parentURL) {\n\t\t\t\treturn void 0;\n\t\t\t},";
	return [
		"\tlet __dshGreenMods;",
	"\ttry {",
	"\t\t__dshGreenMods = internalModules();",
	"\t} catch {",
	`\t\t/* ${MARKER} native probe unavailable -> physical-layout fallback interception */`,
	"\t\treturn {",
		pkgDir,
	"\t\t\treplace() {},",
	"\t\t\tdispose() {}",
	"\t\t};",
	"\t}",
	"\tconst { esm, esmDefaultResolve, esmConditions, cjs, cjsConditions, modern } = __dshGreenMods;",
	"\tconst router = new ResolutionRouter(resolution, (directory) => cjs._nodeModulePaths(directory));"
].join("\n");
}

function patchFile(filePath, indexVariant) {
	const src = readFileSync(filePath, "utf8");
	if (src.includes(MARKER)) {
		console.log(`  SKIP (already patched): ${filePath}`);
		return "skipped";
	}
	if (!src.includes(OLD_ADDON_LOAD)) throw new Error(`pattern A0 not found in ${filePath}`);
	if (!src.includes(OLD_INTERNAL_MODULES)) throw new Error(`pattern A not found in ${filePath}`);
	if (!src.includes(OLD_INTERCEPTION)) throw new Error(`pattern B not found in ${filePath}`);
	let out = src.replace(OLD_ADDON_LOAD, NEW_ADDON_LOAD);
	out = out.replace(OLD_INTERNAL_MODULES, NEW_INTERNAL_MODULES);
	out = out.replace(OLD_INTERCEPTION, `function installRuntimeInterception(resolution) {\n${noopBody(indexVariant)}`);
	if (!out.includes(MARKER)) throw new Error(`patch did not apply to ${filePath}`);
	writeFileSync(filePath, out, "utf8");
	console.log(`  PATCHED: ${filePath}`);
	return "patched";
}

function findBootDirs(root, depth, out) {
	if (depth > 8) return;
	let entries;
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		if (!e.isDirectory()) continue;
		const p = join(root, e.name);
		if (e.name === BOOT_DIR_NAME && existsTarget(p)) {
			out.push(p);
			continue; // 包内不再下钻
		}
		findBootDirs(p, depth + 1, out);
	}
}

function existsTarget(dir) {
	try {
		return statSync(join(dir, "lib/index.js")).isFile();
	} catch {
		return false;
	}
}

// ---- main ----
// 支持多个搜索根: CI 上 pack 前依赖只存在于 .temp-build/pnpm-deps/node_modules,
// 包根 node_modules 由 pack 的 copyMissing 复制生成, 因此两处都要搜 (补丁随复制保留)。
const roots = process.argv.slice(2);
if (roots.length === 0) {
	console.error("usage: node patch-win7-compat.mjs <search-root-dir> [more-root-dirs...]");
	process.exit(1);
}
const found = [];
for (const root of roots) {
	findBootDirs(root, 0, found);
}
if (found.length === 0) {
	console.error(`ERROR: no ${BOOT_DIR_NAME} with lib/index.js found under: ${roots.join(", ")}`);
	process.exit(1);
}
let failed = 0;
for (const dir of found) {
	console.log(`dsh-app-boot: ${dir}`);
	for (const rel of TARGETS) {
		const filePath = `${dir}${sep}${rel.split("/").join(sep)}`;
		try {
			patchFile(filePath, rel === "lib/index.js");
		} catch (error) {
			console.error(`  ERROR: ${error.message}`);
			failed++;
		}
	}
}
process.exit(failed > 0 ? 1 : 0);
