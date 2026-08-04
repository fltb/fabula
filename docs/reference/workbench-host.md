# Workbench Host 运行、配置与作者提交

Workbench 是作者笔记本上的本机 Host。它拥有项目文件、SQLite、Yjs 工作层、提供商凭据和能力令牌；浏览器、MCP 客户端与 Agent 只使用版本化的无秘密 DTO。Native immutable revision 是 authoring acceptance authority；可选 Git 仅镜像已接受 revision，Core 不读取这些资源。

## 启动边界

开发环境要求 Node `26.5.0`：

```bash
fnm exec --using=26.5.0 -- npm run -w @novalistically/workbench dev
```

`dev` 会构建 Host、启动 Host 与 Vite。默认 Host 为 `127.0.0.1:8787`，Vite 为 `127.0.0.1:5173`。已有本地服务占用端口时，显式分开设置两者；`WORKBENCH_PORT` 始终是 Host 和 Vite proxy 的目标，`WORKBENCH_VITE_PORT` 只控制 Vite：

```bash
WORKBENCH_PORT=8790 WORKBENCH_VITE_PORT=5174 \
  WORKBENCH_PROJECT_ROOT=/absolute/path/to/project \
  fnm exec --using=26.5.0 -- npm run -w @novalistically/workbench dev
```

`WORKBENCH_PROJECT_ROOT` 是兼容旧的单项目启动预填项，不是作者历史或多项目配置来源。未显式指定时，开发脚本会把演示 fixture 复制到临时外部目录；退出时清理该副本。配置验证要求 `nova.yaml.project` 与 configured `projectId` 完全一致。

生产先构建，再运行已打包的 Host：

```bash
fnm exec --using=26.5.0 -- npm run -w @novalistically/workbench build
WORKBENCH_HOME=/var/lib/fabula/workbench \
WORKBENCH_ASSETS_ROOT="$PWD/packages/workbench/dist/client" \
fnm exec --using=26.5.0 -- npm run -w @novalistically/workbench start:workbench
```

未配置的生产 Host 仍只绑定 loopback，并提供首次设置页面。LAN 必须由所有者显式配置允许的 Host 与 Origin。TLS 在反向代理终止；Workbench 自己不终止 TLS。`start:listener` 只有 `/health` 和 `/status` smoke listener，不提供 Workbench 工作流。

## 配置和凭据

`$WORKBENCH_HOME/config/workbench.yaml` 是多项目配置的唯一来源。首次设置、所有者管理页面、受权 MCP 管理工具和人工编辑都通过同一个 revision-CAS 配置服务。配置写入成功不等于运行时已切换：Host 在进程启动时固定 listener、提供商、项目根以及 MCP 默认项目，因此以下字段的任意改动都会持久化并返回 `restart-required`：

- `projects`、项目显示名和项目根；
- `defaultProjectId`；
- `provider` 的 endpoint 或 model；
- `network` listener policy。

收到 `restart-required` 后停止并重新启动 Host；不要假定浏览器、Yjs、MCP、Agent 或受控 Git 会热切换到一半配置。外部 YAML 编辑若无效或删除 busy 项目，会保留最后一个有效运行配置并返回诊断。

提供商 API key **不在** `.env`、YAML、浏览器、MCP 工具输出或审计记录中。首次设置或所有者 Provider 页面将其写入 Host 的凭据存储；`HostProviderFactory` 从不回退读取 `NOVALISTICALLY_AI_API_KEY`。环境变量仅控制启动位置、listener 与显式开发 mock；不要把生产 key 放进 `.env.example`。

## 作者工作流与身份

四种身份不可互换：

| 身份 | 含义 | 用途 |
| --- | --- | --- |
| native revision id / accepted source hash | Host immutable revision 与 source 内容身份 | acceptance CAS、restore 与 recovery |
| workspace digest | 在线 Yjs 工作层摘要 | 工作编辑 CAS |
| observed filesystem hash | Host 观察到的手工文件候选 | 外部协调输入 |
| Git mirror commit | 可选 best-effort mirror 的外部 ID | 从不决定 acceptance 或 recovery |

浏览器、MCP 和 Agent 的写入顺序相同：

1. 服务器解析认证主体、project membership 与短期 capability；调用方不能提交 actor、路径或凭据。
2. 编辑进入共享 Yjs 工作层；它不是已接受 source。
3. `AuthoringCoordinator` 在 project session queue 中重新核对 accepted revision、source hash、workspace digest、文档向量与 capability。
4. Core 编译完整候选；通过后 native revision content store 与 revision-head CAS 接受完整 bundle。
5. 可选 Git mirror 仅在 acceptance 后导出；失败写入 mirror 状态但绝不撤销 revision。`.nova/**`、cache、responses、journals、Yjs、SQLite、output 与 derived 工件永不进入 authoring bundle。

Agent 先产生 Host 保存的提议，直到用户显式 apply 才会申请服务器能力并排入 session。人在编辑时，Agent 生成或应用会暂停；向量过期必须重新规划。

## 外部文件协调与冲突处理

当 Host 观察到项目根上的手工编辑时，它将完整候选存入 Host 私有 staging，不会直接改写 accepted revision。只有下列条件同时满足，才能执行 external reconciliation：

- 候选 manifest 完整且有效；
- 每个 authoring 路径的字节与候选完全一致；
- 候选遗漏的 baseline authoring 路径显式删除；
- 接受前再次核验候选、working digest 与 native revision-head CAS。

否则 Host 保留手工内容并报告 conflict；它绝不 reset、覆盖或部分接纳 primary 工作树。恢复步骤：

1. 在 Browser Source Studio 或 MCP 读取当前 accepted revision/source hash、workspace digest、operation receipt 和 external candidate 状态。
2. 保留需要的手工文本到新的 working 编辑，或在项目外备份；不要绕过运行中的 Host 修改 accepted revision。
3. 修复 YAML/source 诊断并基于最新 accepted identity 提交 reconcile；CAS stale 时先重新读取再重试。
4. Git mirror 可在 Host 停止时人工检查，但它不是 recovery 前提。

## 操作错误参考

| 代码 / 状态 | 含义 | 操作 |
| --- | --- | --- |
| `WORKSPACE_STALE` | Yjs 工作层、文档向量或候选摘要已变 | 重新读取，重新应用编辑或重新生成提议。 |
| `ACCEPTED_HASH_MISMATCH` | 另一个提交已改变 accepted source | 刷新 source 与工作层，再基于新 hash 提交。 |
| `CANDIDATE_INVALID` | 完整候选未通过 Core/source 验证 | 修复返回的 YAML/source 诊断；不要强制 Git 提交。 |
| `CONFLICT_REQUIRES_RESOLUTION` | 外部文件候选或受控 Git 工作树不满足精确协调 | 按上一节清理并显式 reconcile。 |
| `SUBMIT_BLOCKED` | 能力被撤销、过期、权限不足或 session gate 拒绝 | 重新认证/授权；不要复用 token。 |
| `DOCUMENT_NOT_FOUND` | 文档不在允许的作者 catalog | 先刷新 catalog；不能用原始路径代替 document id。 |
| `PROJECT_NOT_READY` | 项目 bundle 尚未开放或刚关闭 | 打开已配置项目，或按 `restart-required` 重启。 |
| `INVALID_INPUT` / `UNKNOWN_FIELD` | API version、CAS 字段或严格请求 shape 无效 | 只发送当前 contract 定义的字段。 |
| `restart-required` | 新 YAML 已保存，但当前进程捕获的运行配置仍旧 | 受控停止并重启 Host。 |

所有 operation/audit 读取都是无秘密的。出现 `INTERNAL` 时保留 operationId 和时间，检查 Host 日志与恢复 journal；不要把 token、credential、Git temporary index 或项目根粘贴到 issue。

## 验证清单

- Host：`npm run -w @novalistically/workbench test:host` 与 `typecheck:host`。
- Client：`npm run -w @novalistically/workbench test:client` 与 `typecheck:client`。
- Native revision、restore 与 recovery：`tests/authoring-coordinator-recovery.test.ts`、`tests/host-startup.test.ts`。
- Optional Git mirror boundary：`tests/git-runner.test.ts`、`tests/git-manifest.test.ts`。
- Browser 与 MCP/Agent authoring boundary：`tests/browser-agent-api.test.ts`、`tests/mcp-auth-registry.test.ts`。

这些检查验证 Host 合约；live provider 输出仍需由部署环境的凭据和项目 source 决定。
