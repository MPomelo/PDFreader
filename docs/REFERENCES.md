# 开源参考与集成记录

| 来源 | 实际位置与版本 | 使用方式 | 许可 |
| --- | --- | --- | --- |
| Mozilla PDF.js | https://mozilla.github.io/pdf.js/getting_started/；官方6.5.438包中的web/viewer.html与viewer.mjs初始化/打开入口 | 完整Viewer直接集成；仅增加bridge.mjs、pdfreader.css与HTML引用 | 发布包LICENSE保留，Apache-2.0 |
| Tauri | https://v2.tauri.app/start/prerequisites/，2026-11-14访问 | Windows原生外壳；已核对Rust/MSVC缺项，WebView2存在 | 文档参考，依赖许可交付时汇总 |
| Fluent System Icons | https://github.com/microsoft/fluentui-system-icons/blob/main/packages/svg-icons/README.md；npm @fluentui/react-icons 2.0.316类型导出 | 20 Regular按需引入，未自绘 | MIT，public/licenses/Fluent-System-Icons.txt |

图标映射：打开FolderOpen20Regular；左右栏PanelLeft20Regular/PanelRight20Regular；阅读BookOpen20Regular；文档DocumentPdf20Regular；关闭Dismiss20Regular。
同一动作固定图标，统一20px/currentColor及焦点状态；缺项才同风格原创补绘。PDF.js内部图标保留上游。

2026-11-15 STAGE-01 构建补充：从已安装的 `@fluentui/react-icons` 2.0.316
`lib-cjs/index.js` 的 `DocumentPdf20Regular` 导出渲染出 `src-tauri/icons/app-icon.svg`，
使用已锁定 Tauri CLI 2.12.4 的 `icon` 命令生成 Windows `icon.ico`。
沿用现有图标和强调色，未自绘、未更换图标库；MIT 许可同上。
生成命令见 `src-tauri/icons/README.md`。

## STAGE-02 实际读取与取舍（2026-11-15）

| 来源 | 实际读取位置 / 版本 | 采纳及宿主差异 | 使用方式 / 许可 |
| --- | --- | --- | --- |
| Mozilla PDF.js generic Viewer | 固定 6.5.438 的 public/pdfjs/web/viewer.mjs：open/close、load 的 firstPagePromise、_initializeAnnotationStorageCallbacks、save/downloadOrSave、onBeforeUnload、PasswordPrompt | 继续直接使用上游阅读/编辑 UI；原生落盘由宿主负责。save 的原始文件 fallback 不适用于批注导出，因此在 bridge 中集中接管保存入口；close 的自动下载由宿主离开决策替代 | 直接复用 Viewer，集中适配；Apache-2.0，原 LICENSE 保留 |
| Mozilla PDF.js 显示与保存层 | 同版本 public/pdfjs/build/pdf.mjs：AnnotationStorage.serializable、WorkerTransport.saveDocument 的 finally/resetModified、AnnotationEditorUIManager.endCurrentEditing；pdf.worker.mjs 的 getNewAnnotationsMap、FreeTextAnnotation/InkAnnotation/HighlightAnnotation 的 createNewDict/createNewAppearanceStream | 使用真实 saveDocument 导出，getData 仅用于没有批注的原始数据；额外 ExportState 跟踪成功落盘快照，避免 resetModified 被误当成已保存。测试序列化数据按实际固定版本结构生成，另用独立引擎验证 | API 复用 + 自行实现宿主状态；Apache-2.0，未修改上游构建文件 |
| 既有 Tauri/rfd 与 Rust 标准库 | src-tauri/Cargo.lock：Tauri 2.12.5、rfd 0.15.4；既有原生窗口事件、emit、FileDialog API；本机编译与 Rust 回归验证 | 使用同一原生宿主完成另存、关闭拦截和原子文件替换，无新增桌面运行时、PDF SDK 或生产依赖 | 延续既有依赖；文件写入逻辑自行实现；依赖许可按既有来源 |

STAGE-02 的外部验证使用本机 Poppler 渲染器读取真实导出 PDF，并实际查看 PNG；
未声称操作过其他桌面阅读器。pypdf/Pillow 仅用于生成测试输入和检查渲染，未进入产品依赖。
自由文字独立渲染验证范围为拉丁文字；非基础字体字符的兼容性留在桌面补验表中明确记录。

### 选区关联注释补充（2026-11-15）

- 实际读取同版本 viewer.mjs 的 webViewerLoad/initialize/_initializeViewerComponents、CommentManager/CommentDialog/CommentPopup/CommentSidebar；pdf.mjs 的 FloatingToolbar、AnnotationEditorUIManager.commentSelection、Comment 的标记悬停事件、AnnotationEditor.addComment；pdf.worker.mjs 的 PopupAnnotation.createNewDict 与其默认 Open=false。
- 复用官方 CommentManager：选区高亮定位、关联评论、标记预览、编辑与注释列表；不创建另一套注释数据库。Viewer 默认 enableComment=false，因此用 viewer-entry.mjs 在 preferences 之后、组件构造之前启用 enableComment 和选区浮动工具；上游 viewer.mjs/pdf.mjs/Worker 不改动。
- HTML 仅将原来的独立 Viewer/bridge 脚本入口替换为顺序初始化入口；bridge 中集中包装注释命令与草稿提交。页面脚本禁用规则保持不变。
- 保存仍使用标准 Highlight + Popup，真实中文 Contents、Parent/Popup 引用和关闭状态已由 PDF.js 重开及独立 pypdf 检查；不是截图批注。悬停与列表交互没有原生 UI 通过证据，明确留待复验。
- 直接复用及少量适配；Apache-2.0 许可证沿用原发布包，没有新增生产依赖。

### 独立便签注释兼容补丁（2026-11-16）

- 实际读取 PDF.js 6.5.438 的 AnnotationEditor、AnnotationEditorUIManager、AnnotationEditorLayer、TextAnnotationElement、TextAnnotation 和 AnnotationFactory 保存/打印路径。原生 commentSelection 会调用 highlightSelection，无法满足本次“注释不自动高亮”的要求。
- 新增 note-editor.mjs，复用上游 AnnotationEditor、CommentManager 和 Popup，不复用 HighlightEditor 的数据模型；注释序列化为独立 Text + Popup。
- 对固定版本 pdf.mjs/pdf.worker.mjs 做小范围兼容补丁：选区入口、注释模式的选择与高亮切换、编辑器注册、Text 便签恢复、Worker 保存/打印。scripts/patch-pdfjs-notes.mjs 可在原版 6.5.438 上重放，检查版本和唯一上下文，已应用时幂等返回。
- 保留 Apache-2.0 及上游版权头，无新增运行时依赖。主模块和 Worker 已有修改，因此此前“核心未改动”的描述仅属于旧版集成历史。
- 自动检查验证真实保存/重开及 pypdf 结构；DOM/事件端点由测试替代，桌面行为仍待复验。没有声称 Acrobat/Edge 的原生阅读器兼容验收完成。

## STAGE-03：API 与基础翻译参考（2026-11-16）

以下均为本轮实际读取的源码或官方文档，未复制外部实现。只借鉴架构与协议，产品执行由原生 Rust 与 Windows API 完成，不引入 Zotero 环境、Node 常驻服务或第二运行时。

| 来源 / 实际位置 | 版本或时间 | 读取结果、取舍与边界 | 许可处理 |
| --- | --- | --- | --- |
| [Zotero Translate services/index.ts](https://github.com/windingwind/zotero-pdf-translate/blob/main/src/modules/services/index.ts) 与 [base.ts](https://github.com/windingwind/zotero-pdf-translate/blob/main/src/modules/services/base.ts) | main，读取 2026-11-16，commit 未取得 | 实际读取服务注册、统一 TranslateService、配置与任务处理入口；采用“服务配置 + 一个协议适配器”的结构。发现 Custom GPT 在 gpt.ts，raw 与 GitHub 两种访问均失败；未假称已阅读其提示词实现，改以官方接口与自行组织的最小提示词补足 | 未复制源码，不引入 Zotero 依赖；本轮未取得其许可版本，不宣称直接集成 |
| [AI SDK compatible provider](https://raw.githubusercontent.com/vercel/ai/main/packages/openai-compatible/src/openai-compatible-provider.ts) 与 [chat language model](https://raw.githubusercontent.com/vercel/ai/main/packages/openai-compatible/src/chat/openai-compatible-chat-language-model.ts) | main，读取 2026-11-16，commit 未取得 | 实际核对 Base URL / path 拼接、Bearer、请求体变换、正式 content 与 reasoning/finish reason 分离。采用同样的职责分离，自行用原生实现；没有安装 SDK | 仅架构参考，无复制代码 |
| [DeepSeek 首次调用](https://api-docs.deepseek.com/)、[Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)、[Models](https://api-docs.deepseek.com/api/list-models/) | 当前文档，2026-11-16 | https://api.deepseek.com + /chat/completions，Bearer；默认 deepseek-flash；stream=false；官方 thinking.type 支持 disabled。GET /models 可选，不依赖其成功来允许手填 | 协议参考，无文档大段复制 |
| [MiMo 首次调用](https://mimo.mi.com/docs/en-US/quick-start/summary/first-api-call)、[鉴权](https://mimo.mi.com/docs/en-US/quick-start/faq/api-integration)、[思考模式](https://mimo.mi.com/docs/en-US/quick-start/usage-guide/text-generation/deep-thinking)、[模型列表](https://mimo.mi.com/docs/quick-start/model) | 当前文档，2026-11-16 | 默认 https://api.xiaomimimo.com/v1、mimo-v2.6-flash，api-key（官方也接受 Bearer），max_completion_tokens，thinking.disabled；按量付费和 Token Plan 的密钥 / 地址不能混用。未把 GET /models 支持当作必需条件 | 协议参考，无文档大段复制 |
| Microsoft [CredWriteW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credwritew)、[CredReadW](https://learn.microsoft.com/windows/win32/api/wincred/nf-wincred-credreadw)、[CREDENTIALW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/ns-wincred-credentialw)；本地 windows-sys Credentials 模块 | windows-sys 0.61.2，Windows SDK 10.0.26100.0，读取 2026-11-16 | 安全凭据与配置分离；只回状态，删除 / 替换明确。系统不可用时不自动落盘，使用用户明确选择的原生内存会话模式；实际 dummy-key 探针在代理会话不可用 | 使用现有缓存的 windows-sys Windows 绑定，保留 Cargo 许可元数据 |
| Microsoft [WinHTTP sessions](https://learn.microsoft.com/en-us/windows/win32/winhttp/winhttp-sessions-overview)、[CloseHandle](https://learn.microsoft.com/en-us/windows/win32/api/winhttp/nf-winhttp-winhttpclosehandle)、[ReadData](https://learn.microsoft.com/en-us/windows/win32/api/winhttp/nf-winhttp-winhttpreaddata)；本地 windows-sys WinHttp 模块 | 同上 | 使用异步句柄，取消 / 超时关闭请求；严格保留回调缓冲区到 HANDLE_CLOSING，避免从别的线程关闭同步请求的竞态。Windows 负责 TLS 与分块传输，应用只解析完整 JSON。原生回环网络测试在代理会话失败，待普通会话补验 | 原生 API 使用，无外部样例代码复制 |

网络实现取舍：曾评估 reqwest 0.13.5 的超时 / 禁重试能力，但 crates.io DNS 失败且依赖未缓存，因此未把它纳入成品依赖；使用已有 Windows 绑定与系统 HTTP 接口。只新增已缓存版本的 serde_json / url / windows-sys 直接依赖，Cargo.lock 已离线更新。模拟检查、生产构建与实际厂商调用分别记录，不互相替代。


## STAGE-04：SSE、Markdown 与数学（2026-11-16）

| 来源 / 实际位置 | 版本或读取范围 | 采用方式与许可 |
| --- | --- | --- |
| [WHATWG Server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html) | UTF-8、行分割、空行分发、data 多行、注释/事件字段 | 协议参考；Rust 自行实现 Chat Completions 专用解析，不引入第二套 HTTP 客户端 |
| [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/) 与 [MiMo 思考模式](https://mimo.mi.com/docs/en-US/quick-start/usage-guide/text-generation/deep-thinking) | SSE delta、reasoning、finish_reason、用量与结束标记；MiMo 在最终 EXE 用固定短句与公式实调 | 沿用上一阶段窄适配；DeepSeek 缺凭据不冒充实测 |
| [react-markdown 官方数学与安全示例](https://github.com/remarkjs/react-markdown)、实际 node_modules/react-markdown/readme.md | react-markdown 10.1.0；remark-gfm 4.0.1、remark-math 6.0.0、remark-parse 11.0.0、unified 11.0.5 | 直接复用成熟 AST 链；关闭原始 HTML 和远程图片；MIT |
| 实际 node_modules/rehype-katex/lib/index.js、[KaTeX options](https://katex.org/docs/options.html) | rehype-katex 7.0.1、KaTeX 0.19.1；错误捕获后局部回退，trust=false、maxExpand/maxSize；本地 CSS/字体 | 同一数学引擎；package override 保证传递依赖也统一到 0.19.1；MIT |
| [KaTeX 字体 LICENSE](https://github.com/KaTeX/katex-fonts/blob/master/LICENSE) 与实际 KaTeX 包许可 | 字体随 KaTeX 包本地打包，未从 CDN 动态拉取 | MIT；保留分发许可 |

运行时 JavaScript 的许可/NOTICE 由 scripts/collect-runtime-licenses.mjs 按 package-lock 与实际安装包收集到 public/licenses/Runtime-JavaScript-Notices.txt（268 个许可节），随前端和 EXE 分发；Fluent 图标保留既有独立许可。Playwright、测试服务器和合成 PDF 仅用于开发验收。

GitHub raw 形式的若干数学/解析参考源码地址本轮访问失败，未声称读取失败地址；实际采用依据为可访问的官方文档、上述已安装包源码及固定分块测试。没有直接复制外部 SSE 实现。


## STAGE-05：本地仓库与视觉收敛（2026-11-16）

| 来源 / 实际位置 | 版本与范围 | 采用与许可 |
| --- | --- | --- |
| @fluentui/react-icons 的 lib-cjs/sizedIcons/chunk-*.js | 2.0.316；读取本轮新增的 10 个 20 Regular 实际 SVG 路径，摘录见 test-results/stage05/fluent-icon-source.json | 直接复用、currentColor；MIT，既有许可证保留 |
| public/pdfjs/web/viewer.mjs、viewer.css、viewer-entry.mjs | 固定 PDF.js 6.5.438；读取初始视图/firstPagePromise/documentinit、ViewOnLoad、颜色方案/掩模图标和缩放事件 | 复用 Viewer；集中桥接内容哈希恢复、文字锚点、主题，保留上游图标；Apache-2.0 |
| 本项目 files.rs / translation.rs 既有原子保存；rfd 本地 win_cid/file_dialog.rs、utils.rs | rfd 0.15.4；实际读取文件选择、COM 初始化和同步/异步边界 | 本地版本化 JSON 自行实现，复用现有系统对话框/文件保存基础，无新运行时或新第三方依赖 |

图标映射：更多→MoreHorizontal20Regular；浅/深色→WeatherSunny20Regular/WeatherMoon20Regular；浮窗翻译→Translate20Regular；固定→Pin20Regular；目录→TextBulletListLtr20Regular；最近→History20Regular；笔记→Note20Regular；笔记导出→ArrowDownload20Regular；删除笔记→Delete20Regular；关闭沿用 Dismiss20Regular。

本轮没有语义缺口，因此未自绘 SVG，也未为了自绘而替换成熟图标。外层主图标20px，左栏紧凑页签将同系列SVG统一显示16px，按钮仍至少32px；PDF.js 上游图标保留。浅/深主题、禁用、焦点和掩模颜色在 stage05.css / pdfreader.css 中集中协调。

参考仅限上述三个直接来源；本地仓库、哈希身份、缓存隔离及笔记组织为项目实现，不冒称复用外部插件代码。运行时 JavaScript 通知清单继续使用既有版本，共268节。


## STAGE-05 范围扩展：多标签、统一设置与工具栏（2026-11-17）

| 来源 / 实际读取范围 | 用途 | 复用与许可 |
| --- | --- | --- |
| PDFgear 官方[工具栏说明](https://www.pdfgear.com/windows-user-guide/pdfgear-toolbar.htm)及页面截图 | 参考文档标签、常用命令分组和文档导航入口 | 设计参考，未复制源码或图片 |
| PDFgear 官方[偏好设置](https://www.pdfgear.com/windows-user-guide/preferences-windows.htm)及[更新记录](https://www.pdfgear.com/whats-new/) | 参考独立设置入口、默认缩放及多 PDF 标签交互 | 设计参考，未新增依赖 |
| 本地 PDF.js 6.5.438 的 viewer.mjs / viewer.css / bridge.mjs | 核对旋转、缩放、查找、批注、缩略图与原生菜单入口；每文档独立 Viewer | 继续复用既有 Apache-2.0 内核；宿主工具栏桥接不改写 PDF 编辑器 |
| @fluentui/react-icons 2.0.316 | 工具采用 Wrench20Regular；设置 Settings20Regular；文件页签 DocumentPdf20Regular；关闭 Dismiss20Regular | MIT，均为既有 20 Regular 图标，不新增自绘或运行时依赖 |

本轮交付检查与截图见 test-results/workspace；旧的“更多”图标映射保留为历史记录，当前“工具”使用扳手并显示文字。运行时许可证清单仍为既有 268 节。


## STAGE-06：单实例与安装交付（2026-11-17）

参考并实际核对 Tauri 官方 [Single Instance](https://v2.tauri.app/plugin/single-instance/)、[Windows Installer](https://v2.tauri.app/distribute/windows-installer/)及本地 config.schema.json。直接集成固定 tauri-plugin-single-instance 2.5.5（Apache-2.0 OR MIT），命令行入队由项目实现，前端就绪前不丢文件。使用官方 NSIS 分发与 useLocalToolsDir 缓存；Open-with 注册为项目自有安装钩子，不写默认 .pdf/UserChoice。

原生/构建依赖 245 项的完整许可及准确版本源码地址已生成到 public/licenses/Runtime-Rust-Notices.txt；未打包许可证的少数包从 crate 的 VCS commit 对应上游补齐，selectors 使用 Mozilla 官方 MPL-2.0 全文。补充来源见 public/licenses/upstream/sources.json；原 MPL 组件未修改。
