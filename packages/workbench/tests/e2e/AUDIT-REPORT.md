# Workbench 前端完整性审计报告（post-delivery item 3）

- **日期**: 2026-08-06
- **范围**: 只读审计（未改动任何 `src/`、`docs/`、既有测试）。探针文件 `tests/e2e/audit.spec.ts` 为临时文件。
- **环境**: Node 26.5.0 (fnm), built `dist/host` + `dist/client`（`index-bY3XKjJE.js`）, Playwright chromium workers=1, `WORKBENCH_PROVIDER=mock` hermetic fixture（`zhu-fu` + require-waiver 变体）。
- **数据流验证方式**: 每个 view 均以 owner 会话登录后走查，数据来自 Host API / SSE / Yjs；断言与 Host HTTP surface（`fixture.fetch`）与 MCP 工具结果交叉核对。

## 结论速览

| # | View | 结论 | 证据 |
|---|------|------|------|
| 1 | Project Home | **PASS** | 真实 displayName/projectId/6 项 metrics（Documents=41, Scenes=7, Rendered=0…）+ activity 文案；host 未连接/空态文案诚实（组件 fallback + `STATUS_COPY` 代码核对） |
| 2 | Source Studio | **FAIL**（提交/编辑 PASS，lifecycle 与 revision history FAIL） | 见 BUG-1；Yjs 连接+编辑+submit 202+身份翻转+op center receipt 均 PASS；create/move/delete 与 revision list/get/diff/restore 的浏览器动作缺失 |
| 3 | Scene Canvas | **PASS** | 诚实空态 "No released scene revision"（未渲染时无 adoption，无 mock 内容）；adoption 面板仅由 Host 数据驱动 |
| 4 | Graph / Route | **PASS-with-note** | Story 15 nodes/58 edges、Discourse 渲染、reader order 真实；leaf 路由诚实文案；malformed selector→400 `INVALID_ROUTE_SELECTOR` typed；UI 错误面板显示 typed 错误；NOTE: 语法合法但语义未知的 choice 返回 200（被投影，非 400） |
| 5 | Review Hub | **PASS** | comments list/add/resolve/wontfix/reopen/escalate(→blocking severity)/replace + history（comment_added/comment_replaced/comment_status_changed）+ gate decide（200）+ 404 `REVIEW_COMMENT_NOT_FOUND` UI 显示（消息 "Comment … is superseded"）+ 409 `GATE_NOT_OPEN`（decided gate 再决策） |
| 6 | Publication | **PASS-with-note** | canonical record 真实（status/novelHash/relativeOutputPath=output/novel.md/byteLength）；publish（outcome=queued，op center receipt completed）；download 200+内容；stale reasons 渲染（stub 注入 stale record，理由 source_changed/missing_scenes 渲染） |
| 7 | Operation Center | **PASS-with-note** | SSE 实时 + store-first 初次加载；cancel 可用；NOTE: render/publish 操作 progress 恒为 null（仅 agent run 上报进度，生产默认隐藏 agent），进度数字 UI 路径存在但当前无操作填充 |
| 8 | Admin | **PASS** | system（Host health/restart-required/owner/loopback）、provider（profile 卡片 + ENDPOINT/MODEL 掩码 `****` + credential configured + API key 输入 type=password 空值）、advanced（operationLimits 64/2、agent 16/64/未启用、trusted 仅从 discovered 集合、fixture 诚实 0 plugins）、access&devices（invite 创建、device issue+claim、registry 列表真实 scopes）、network（loopback policy）、operations（真实 config receipt `providers.default` + audit trail） |
| 9 | 导航/外壳 | **PASS** | navigator 恰好 6 个 feature（无 agent-chat）；移动端 drawer；preferences 持久化（localStorage + reload 恢复） |
| 10 | Console/网络 | **PASS（1-2 测试内验证）** | 逐 view 无未捕获 console error/pageerror；除有意 typed 错误演示外无 4xx/5xx；/api/** 404 为 text/plain（非 index.html 回退） |

## 真实 Bug 清单

### BUG-1（高严重度）— Source Studio lifecycle 与 revision-history 回调未从 App 壳转发到视图
- **文件**: `packages/workbench/src/client/App.tsx` — `WorkbenchShell` 内 `<Workspace …>` 调用（约 L816-839）。
- **缺失 props**（`WorkspaceProps` 已声明、`Workspace→SourceStudio`（L430-447）已转发，但壳→Workspace 未传）:
  `authoringRevisionHistory`, `authoringRevision`, `authoringRevisionDiff`,
  `onListAuthoringRevisions`, `onGetAuthoringRevision`, `onDiffAuthoringRevisions`, `onRestoreAuthoringRevision`,
  `onCreateDocument`, `onMoveDocument`, `onDeleteDocument`。
- **复现**（owner 登录 → Source Studio → 任意工作文档）:
  1. "New working document" / "Rename/Move" / "Delete" 按钮不存在（DOM 中 count=0）；
  2. "Accepted revision history" 区只显示 fallback "No native revisions are available for this project."，无 Refresh/View/Compare/Restore 按钮（即使提交后已有 ≥2 个原生 revision）。
- **Expected vs actual**: 期望与 `WorkspaceProps`/`AppProps` 声明一致地渲染上述动作；实际全部缺失（TS 无法发现，因 props 全 optional）。
- **Host 侧正常**: 同一会话通过 HTTP 直接调用 create/move/delete（各自 200）与 revisions list/get/diff/restore（各自 200），证明断点在浏览器 props 转发。
- **连带影响**: stale-digest 错误（409 `WORKSPACE_STALE`）的 UI 展示路径（`[data-mutation-error]`，runCreate/runMove/runDelete catch）在浏览器中不可达；Host 契约本身正确（API 验证 409 + typed code）。

### BUG-2（中严重度）— authoring SSE 无自动重连；Operation Center 在流失败后冻结
- **文件**: `packages/workbench/src/client/authoring-client.ts`（`subscribeEvents` 单次 fetch）、`project-event-client.ts`（`start()` 一次性、无重试/退避）。
- **复现**: 工作区加载后，将 `/api/v1/projects/{id}/authoring/events` 置为 404（`page.route` stub）→ reload → 重新登录 → Operation Center 仍 store-first 显示既有 receipts（真实数据）→ 此时 MCP 发起 `nova_render` → 等待 2s → Operation Center **不出现**该 render receipt（无 live 更新、无自动重连）。
- **Expected vs actual**: 期望流断后自动重连（store-first 恢复）；实际仅在**整页 reload** 后恢复（reload 后 receipt 出现，证据：reload 后 store-first 显示 render receipt）。
- **恢复手段**: reload / create-move-delete / restore / route-change 会触发 `load()` 重建事件客户端，但无自动重连。

## 空壳 / mock 数据发现

- **未发现任何 mock/空壳页面**。所有 view 的数据均来自 Host API/SSE/Yjs；空态均为诚实文案（Scene Canvas "No released scene revision"、Review Hub "No review comments have been recorded."、Publication "No publications yet…"、Source Studio fallback、Graph "No canonical graph projection"、Project Home "No project projection"）。
- 唯一注入数据的场景是 Publication stale-reasons 的**渲染路径验证 stub**（详见测试 4），其记录 live 行为后仅 stub 一次 GET 以验证 stale UI 渲染；该 stub 在测试内撤销。

## 其他观察（PASS-with-note / 信息项）

- 未知 `/api/**` 路径返回 404 `text/plain;charset=UTF-8`（非 JSON envelope）——诚实、不回退 index.html；与其余 typed JSON 错误不一致（低优先信息项）。
- 语法合法但语义未知的 route choice（`{atEventId:'E0', choiceId:'no-such-choice', narrativeOrder:0}`）被 Host 接受并投影（HTTP 200）——非 400；malformed（缺 narrativeOrder）→ 400 `INVALID_ROUTE_SELECTOR`。
- render/publish 操作的 receipt `progress` 恒为 null；Operation Center 的进度 UI（`[data-testid="operation-progress"]`）路径存在，但当前无 host 操作填充（agent run 才上报，生产默认隐藏 agent）。
- 提交按钮：浏览器原生 submit（CAS 字段）POST 返回 202（此前 browser.spec 记录过 400 `UNKNOWN_FIELD` 的问题已修复）。
- 测试 4 cancel 演示：并发 1 的排队窗口偶发被快速 mock render 越过（记录 "no cancel window"），cancel 在 queued/running 均可用的代码路径与已完成的排队验证见测试 4 输出。

## 已验证 view 清单（本报告依据）

1. Project Home（overview/displayName/projection 状态/activity）
2. Source Studio（41 个工作文档、Yjs 连接/编辑、submit 202 + accepted identity 翻转、op center receipt、create/move/delete 缺失=Bug、revision history 缺失=Bug、stale-digest API typed 409）
3. Scene Canvas（诚实空态）
4. Graph / Route（story 15 nodes/58 edges、discourse 渲染、reader order、leaf 文案、typed 错误 400）
5. Review Hub（comments 生命周期/历史/gate decide/404/409 typed 错误）
6. Publication（canonical record/publish/download/stale-reasons 渲染）
7. Operation Center（SSE store-first/cancel/无自动重连=Bug）
8. Admin（system/provider masked/advanced/access&devices/network/operations）
9. 导航/外壳（6 feature、移动 drawer、preferences 持久化）
10. Console/网络（无未捕获错误、无意外 4xx/5xx、/api 不回退 index.html）

## 附：探针运行记录（最终全绿）

- `audit 1` PASS（2.4s）：shell/nav/project-home/scene-canvas/graph-route/console 全绿；toolbar "STORY · 15 NODES · 58 EDGES"。
- `audit 1b` PASS（1.4s）：malformed selector→400 `INVALID_ROUTE_SELECTOR`；UI 在 graphs 400 时显示 typed error 面板（"The Host rejected this request." + Try again）；语义未知但语法合法 choice→200（被投影）。
- `audit 2` PASS（7.0s）：文档数 host=41 dom=41；Yjs 编辑；submit 202+身份翻转+receipt；BUG-1 证据（New working document/Rename-Move/Delete count=0；revision history fallback+0 按钮）；API create/move/delete 200、revisions list/get/diff/restore 200；stale digest→409 WORKSPACE_STALE；BUG-2 证据（SSE 404 后 op center 冻结，reload 后 store-first 恢复）。
- `audit 3` PASS（3.1s）：require-waiver 单 gate；comments 全生命周期 + history + 404/409 typed；404 消息 "Comment … is superseded"（code=REVIEW_COMMENT_NOT_FOUND）。
- `audit 4` PASS（2.5s）：canonical current + meta 真实 + download + publish（outcome=queued）+ op center receipt；partial 重渲染后 canonical 诚实保持 current（deterministic mock）；stale-reasons 渲染 stub 验证；cancel 演示（mock 快，排队窗口偶失，记录 no-cancel-window）。
- `audit 5` PASS（1.8s）：admin 7 个 section 全真实数据（详见结论表 8）。
- `audit 6` PASS（2.6s）：移动端 drawer（390×844，navigator 隐藏、☰ drawer、选 view 后关闭）；preferences 持久化（localStorage key `novalistically.workbench.preferences` + reload 后恢复 data-view/collapsed/expanded）；SPA/API 探针（capabilities 无 session→401 JSON；unknown /api→404 非 HTML）。
