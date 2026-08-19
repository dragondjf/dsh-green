# DSH Green Pack (Windows 7) 构建注意事项

> 适用对象：`dsh-green-win7-v22.22.3` 制品包的维护/重新打包。
> 本文档基于一次真实的 Win7 启动故障排查（sharp `ERR_DLOPEN_FAILED`）整理。

---

## 1. 核心结论

- Win7 上唯一能稳定运行的 sharp 是 **纯 WASM 构建**（`@img/sharp-wasm32`）。
- sharp 0.35.3 的原生二进制 `sharp-win32-x64-0.35.3.node` 依赖的 `libvips-42.dll`
  引入了 **`WaitOnAddress` / `WakeByAddressAll` / `WakeByAddressSingle` / `ProcessPrng`**，
  这些 API 只在 **Windows 8+** 的 kernel32 中导出，Win7 加载必然报
  `ERR_DLOPEN_FAILED: The specified procedure could not be found`。
  装任何 VC++ 运行库都无济于事（不是缺 DLL，是 OS 级 API 缺口）。
- 修复方式：在制品包内安装 `@img/sharp-wasm32@0.35.3`（及依赖 `@emnapi/runtime`）。
  sharp 加载器（`node_modules/sharp/dist/sharp.cjs`）原生二进制失败后会自动回退到
  `@img/sharp-wasm32/sharp.node`，无需改任何业务代码。

## 2. 制品包必须包含的东西

| 条目 | 说明 |
|---|---|
| `node.exe` | **Win7 专用 Node 22.22.3 定制构建**（119,848,448 字节）。官方 Node 22 不支持 Win7，不可替换。 |
| `npm.cmd` / `npx.cmd` | 仅占位；`node_modules\npm` **不存在**，包内 npm 不可用（有意为之，离线制品）。 |
| `run.bat` | 启动入口：`node --expose-internals node_modules\@deepseek-ai\dsh\lib\bin.js web`，并把包根目录加入 PATH（便于 DLL 解析）。 |
| `node_modules\@img\sharp-win32-x64` | 原生包，Win7 上必然加载失败，**但保留**——加载器靠它的失败触发 WASM 回退。 |
| `node_modules\@img\sharp-wasm32` | **Win7 关键包**，必须与 sharp 版本严格一致（当前 0.35.3）。 |
| `node_modules\@emnapi\runtime` | WASM 运行时依赖（^1.11.1），由 sharp-wasm32 的 dependencies 带入。 |
| 其余 `node_modules\@deepseek-ai\*` 及全部依赖 | 完整还原（见 §5 恢复方法）。 |

## 3. 原生模块兼容性清单（Win7 实测）

| 模块 | 版本 | 状态 | 说明 |
|---|---|---|---|
| sharp (win32-x64 原生) | 0.35.3 | ❌ 加载失败 | 见 §1，靠 WASM 回退兜底 |
| @img/sharp-wasm32 | 0.35.3 | ✅ 可用 | 元数据/resize/编码全部实测通过（libvips 8.18.3） |
| @koromix/koffi | 3.1.5 | ✅ 加载正常 | FFI，供 fs/sandbox/ACL/目录选择等使用 |
| node-addon-require-builtin | 0.1.5 | ✅ 可用 | N-API v9 |
| node-pty | 1.2.0-beta.15 | ⚠️ 加载可以，**spawn 必失败** | 1.x 仅支持 ConPTY（Win10 1809+），Win7 报 `Cannot launch conpty`；无 winpty 回退。仅影响终端/子进程交互功能，默认 web 配置不阻塞启动。 |

## 4. 打包格式注意事项

- 原始制品 `dsh-green-win7-v22.22.3.zip` **实际上是 tar**（GNU LongName ASCII，
  UTF-8 码页），只是后缀名是 .zip。7-Zip 可正常读写；
  .NET `ZipFile`/`Expand-Archive` 会报 “Split or spanned archives are not supported”。
- 重打包时建议继续用 7-Zip 生成同格式（或直接用 .tar），保持与既有工具链一致。
- tar 内根目录为 `dsh-green\`，解压到目标时注意目录层级。

## 5. 维护注意事项（重要！）

- **禁止**在制品包根目录直接跑 `npm install <pkg>`：
  包根没有 `package.json`，npm 会把现有 node_modules 视为“多余包”并**全部剪除**
  （实测一次 `npm install` 删掉了 526 个包，整个 `@deepseek-ai` 树被清空）。
- 需要增删包时，二选一：
  1. 用外部可用 npm（如 `dsh-web-0.1.0-rc.5-win32-x64\node\npm.cmd`）在**临时目录**
     装好后把包目录拷贝进 `node_modules`；
  2. 手工下载 npm tarball（`https://registry.npmjs.org/<pkg>/-/<pkg>-<ver>.tgz`）
     解压后放入 `node_modules` 对应位置，并处理其 dependencies。
- 恢复被剪除的 node_modules：用 7-Zip 从原始归档只解压 `dsh-green\node_modules\*`
  再 `robocopy /E` 合并（保留新增的 sharp-wasm32/@emnapi，不丢文件）。
- 升级 sharp 时**必须同步升级** `@img/sharp-wasm32` 到同版本（当前均 0.35.3），
  否则回退路径 require 失败。

### 5.1 使用 makefile 自动构建（推荐）

`make win7` 已内置 sharp WASM 回退处理，无需手工装包：

- 依赖以 pnpm hoisted 安装到 `.temp-build/pnpm-deps`（扁平 node_modules，dsh 从顶层解析依赖）。
- `install-sharp-wasm` 步骤自动检测 `sharp` 实际版本，用 npm 在临时目录安装
  `@img/sharp-wasm32@<sharp版本>`（pnpm 在已有依赖树下不会把 wasm32 平台包落到磁盘，
  故改用 npm 安装后复制进 pnpm modules 顶层）。
- `pack` 的复制是**递归补差**：顶层包已存在时只补充缺失子项（`@img` 目录已存在也会
  把新增的 `sharp-wasm32` 补进去），单文件用 `copyFileSync`（避免 xcopy 的文件/目录歧义）。
- 因此 `@img/sharp-wasm32` + `@emnapi/runtime`（+ 顶层已有 `tslib`）会自动进入制品包，
  与 `@img/sharp-win32-x64` 共存——Win7 上原生加载失败后自动回退 WASM。

## 6. 运行时注意事项

- `DSH_HOME` 是用户环境变量（当前为 `C:\Users\yfjz\Downloads\dsh-green\data`），
  制品包与开发/其它实例**共享同一 home**。
- 端口默认 3080（`dsh-web-app/cordis.patch.yml`：`ctx.webStartup.port ?? 3080`），
  可用 `web --port <n>` 覆盖；若 3080 已被占用会绑定失败。
- 首次启动会执行 profile 修复（`healProfilesModuleFallback`，对
  `$DSH_HOME/profiles/...` 下的模块链接做 unlink/重建）——在沙箱或权限受限环境会
  报 EPERM，正常桌面环境无此问题。
- 建议 run.bat 中显式设置 `DSH_HOME` 指向包内目录，做成真正自包含的离线制品。

## 7. 发布前验证清单

```bat
:: 1) sharp 冒烟（应输出 SHARP OK，libvips 8.18.3）
"%BASE_DIR%node.exe" -e "const sharp=require('sharp');console.log('SHARP OK',sharp.versions.vips)"

:: 2) 完整启动（换端口避免与已运行实例冲突）
"%BASE_DIR%node.exe" --expose-internals node_modules\@deepseek-ai\dsh\lib\bin.js web --port 3091
::    期望输出: dsh web: http://127.0.0.1:3091
::    HTTP GET http://127.0.0.1:3091 应返回 200 且含 window.__DSH_BOOT__

:: 3) 原生模块抽查
"%BASE_DIR%node.exe" -e "require('@koromix/koffi-win32-x64/win32_x64/koffi.node')"   :: 应成功
```

## 8. 已知限制（Win7 专属）

- 附件图片处理走 WASM：速度慢于原生，超大图（>4 千万像素上限内）解码较慢，属可接受范围。
- 终端/PTY 交互不可用（node-pty 需要 ConPTY，Win10 1809+），涉及 `dsh-subprocess-local`
  的交互式子进程功能。
- 系统缺少 `vcruntime140_1.dll`（Win7 常见）：当前包内所有原生模块都不需要它；
  若未来加入新原生模块遇到 `ERR_DLOPEN_FAILED`，先装
  “Microsoft Visual C++ 2015–2022 Redistributable (x64)” 补全运行库再排查。

---

*整理时间：2026-08 修复 dsh-green-win7 启动故障后沉淀。*