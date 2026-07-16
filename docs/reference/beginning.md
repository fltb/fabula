# AI Harness 小说创作框架
_2026-07-16 11:12:32 | Model: gpt-5-5-mini_

### User
我现在有个 idea
我想制定一个 AI Harness 辅助小说创作的框架，参考软件开发维护和 devops 的工作流去类比其中的概念，方便创作

目前是有大模型酒馆这个软件了，但是我希望更进一步？

你仔细列出典型的开发过程（比如前端开发）和大模型酒馆的过程，原理和细节，详细

然后判断这个方向是否可行，预期上限在哪里@Deep research

### Tool
执行摘要

本文提出将软件开发（尤其是前端开发和DevOps）工作流程与小说创作相类比，设计一个基于AI的“小说创作管道（AI Harness）”框架。首先概述典型的前端开发流程，包括各阶段目标、工具和交付物，并通过表格形式总结；其次详细分析现有的“大模型酒馆”软件（即SillyTavern）在架构、组件、交互、提示词管理、模型调用、数据流、日志监控、扩展机制、多用户协作和检索增强等方面的原理、优缺点。然后逐项映射软件开发/DevOps流程到小说创作流程，例如“需求分析→故事大纲”“单元测试→情节一致性检查”“CI/CD→自动化质量回归”“部署→连载发布”“监控→读者反馈分析”等，并用表格和流程图展示映射关系。基于此映射，设计一个“AI Harness”框架架构图（采用 Mermaid 图），包含创作管理、版本控制、提示词库、模型调度、评估测试套件、自动化流水线、审稿协作、发布监控、回滚机制、插件扩展接口、数据隐私合规等模块，并说明每个模块职责、接口、技术选型、可替代方案及优缺点。随后评估该方向的可行性，包括技术可行性、产品定位、商业模式、用户体验风险、伦理与版权问题、数据需求与标注成本、运维成本、性能瓶颈与上限等，并给出量化或半量化的关键指标（如活跃作者数、章节生成速度、人工干预率、成本范围等）。最后给出分阶段实施路线图（MVP、Beta、1.0），列明每阶段里程碑、最小可行功能、资源需求和时间估计，以及关键风险与缓解策略、后续调研问题列表和优先级排序。报告综合了相关中文资料和官方文献，以确保分析深入详尽、引用规范可靠。
1. 软件开发及 DevOps 工作流程综述
1.1 典型角色与分工

前端开发与DevOps团队中常见角色包括：产品经理/需求分析师（负责需求梳理和产品规划）、UI/UX设计师（负责界面和交互设计）、前端开发工程师（实现用户界面和业务逻辑）、后端开发工程师（提供API服务）、测试/QA工程师（编写测试用例、执行功能与性能测试）、DevOps/运维工程师（负责部署环境、CI/CD流程、监控与维护）、项目经理/Scrum Master（协调团队、管控进度）等。各角色在敏捷开发环境下通过每日站会、迭代计划和评审会等形式密切协作。
1.2 开发阶段、目标与工具

软件开发生命周期（SDLC）可划分为需求分析、系统设计、编码实现、测试验证、部署上线和运维维护等阶段。以下表格比较了各阶段的主要目标、输入/输出、常用工具和关键度量指标：
阶段	目标	输入/输出	常用工具	度量指标（示例）
需求分析	明确用户需求和业务目标，产出需求文档	输入：客户/产品需求、市场调研；输出：需求规格说明书、用户故事	需求管理（JIRA、Trello、Notion）；原型设计（Axure、Figma、Sketch）	需求覆盖率、需求变更数量、评审通过率
系统设计	进行技术方案和界面设计，确定系统架构和技术选型	输入：需求文档；输出：系统设计文档（架构图、接口规范、数据模型等）	设计工具（Figma、Zeplin、Sketch）；协作（Confluence、Miro）；架构工具（UML、PlantUML）	设计评审通过率、架构可扩展性指标
编码实现	编写符合设计的前端代码，实现页面功能和交互	输入：设计文档、接口文档；输出：前端源代码、页面组件	编辑器（VS Code、WebStorm）；前端框架（React、Vue、Angular）；构建工具（Webpack、Vite）；代码规范（ESLint、Prettier）；版本控制（Git）	完成功能数、提交/PR数量、代码行数、代码复杂度
功能测试	验证实现是否符合需求，消除功能缺陷	输入：开发完成的代码、测试计划；输出：测试报告、缺陷清单	测试工具：单元测试（Jest、Vitest）；接口调试（Postman、Swagger）；端到端测试（Cypress、Selenium）；持续集成工具（Jenkins、GitHub Actions）；代码审核（Git PR/MR）	缺陷率、覆盖率（单元/接口/集成）、测试通过率
部署发布	将系统部署到生产环境，正式对外提供服务	输入：已测试的构建产物；输出：上线发布的可用系统	部署环境：服务器/容器（Nginx、Docker）；云平台（AWS、阿里云、Vercel/Netlify）；CI/CD工具（Jenkins、GitLab CI、GitHub Actions）	部署成功率、部署时间、上线故障率
运维维护	监控系统运行、收集用户反馈、快速修复问题并持续改进	输入：运行日志、监控数据；输出：故障报告、优化补丁、迭代计划	监控工具：Prometheus + Grafana、ELK 日志、Sentry；反馈工具：数据分析（Google Analytics）、用户调研	系统可用率（uptime）、故障恢复时间、用户满意度

以上各阶段均采用迭代方式灵活推进。在敏捷环境中，还会进行每日站会、冲刺评审和回顾，并采用持续集成/持续交付（CI/CD）等实践来提高交付频率和可靠性。质量保障措施包括代码审查（Peer Review）、静态代码分析（SonarQube等）、全自动和手动测试。版本控制通常使用Git，结合分支管理（如GitFlow）确保代码回滚和版本记录。自动化监控系统通过日志（Log）、指标（Metrics）和用户行为分析闭环产品质量，快速发现并回滚/修复异常。
2. “大模型酒馆”现状分析

大模型酒馆（对应英文Sil𝚕𝚕𝚢Tavern）是一款本地部署的角色扮演对话前端界面，可连接多种LLM模型和生成API。它主要面向AI爱好者和创作者，提供丰富的功能来定制对话体验，但并不包含具体的AI模型，需用户自行接入模型API。

    架构与组件：酒馆采用前后端分离的架构，基于Node.js搭建。前端界面使用HTML/JS/CSS渲染，提供聊天面板、角色卡编辑、世界信息（World Info）管理、提示词管理等功能。后端负责与LLM API（如OpenAI、AI Horde、KoboldAI、本地Ooba/Tabby等）的通信、返回结果处理和会话管理。主要组件包括：角色卡管理（Character Cards）、对话历史、提示词管理器、世界信息库、群组聊天引擎、插件管理器等。

    用户交互：用户通过图形界面选择或创建“角色卡”（一组预设提示，类似ChatGPT的GPTs或Poe的机器人）来定义对话的背景、角色人格和世界观。然后在聊天窗口输入消息，系统将用户消息与角色卡中的“系统提示词”、“场景信息”、“角色个性”等上下文拼接为最终提示，调用后端模型API生成回应。支持多轮对话，上下文存储在本地会话历史中。还支持群组对话（multi-bot）模式，让多个AI角色互相交流。界面提供高级设置，如上下文大小、采样温度、最大生成长度等参数调节。

    提示词管理：内置提示词管理器，允许用户自定义系统提示、世界描述、角色个性、续写模板等多段提示，并控制它们的发送顺序和条件。用户可以对常用提示词进行分组、复用或快速插入，并为不同场景定义不同模板。提示词管理器通过可视化界面（拖拽排序、文本框输入）帮助用户组织复杂上下文。角色卡本质上就是这些提示词的集合，确保每次聊天都按设定主题开展。

    模型调用与数据流：当用户发送输入时，前端收集当前聊天历史、角色卡提示词和其他上下文，通过API请求发送到指定的LLM后端。后端可能是云端API（如OpenAI、Anthropic）或本地服务（如Ooba API、AI Horde）。模型生成响应后，经后端返回给前端并展示。整个流程中，用户数据和聊天记录仅保存在本地（软件不提供云同步功能），用户自己掌控数据和所接入模型。
    数据流简要为：用户输入 → 组装提示（系统 + 角色 + 用户历史） → 调用模型API → 获取生成文本 → 显示到聊天界面 → 存入对话历史。

    日志与监控：酒馆本身没有专门的实时监控仪表盘，一般只记录基本的运行日志（如请求错误、API返回情况）。由于是本地部署工具，不含在线监控服务。用户可通过节点/浏览器控制台查看日志，也可自行外挂日志收集系统。若需分析用户行为，则需额外工具或集成第三方服务。

    扩展性与插件机制：SillyTavern具有插件扩展能力。用户可以通过“Extensions”菜单安装社区制作的脚本或模块，常见扩展功能包括：聊天记录自动摘要、界面风格/文字翻译、角色表情精灵动画、多模态输入（Stable Diffusion图生/图传）和语音输出（TTS）等。扩展可以使用内置脚本语言（STScript）、自定义CSS或直接API挂接，不会修改核心代码。开发者社区活跃，插件生态在不断增长，可按需增加特定功能（如信息检索RAG插件、情绪识别等）。

    权限与多用户协作：原生酒馆设计为单用户本地应用，无账号系统和角色权限管理。虽然支持“群聊”角色交互，但均在一个人本机运行，无法多人同步编辑或共同创作。对于多人协作，需要借助版本控制（如Git）、共享配置或部署云服务的方式来实现，目前并无开箱解决方案。

    检索增强（RAG）与训练/微调：酒馆内置世界信息（World Info）功能，允许用户为角色卡上传文档（如小说世界观设定、参考资料等），模型在生成回复时可引用这些文档内容，从而实现检索增强生成（RAG）。此外，尽管酒馆不直接提供模型训练或微调功能，用户可以自行准备微调好的专属模型并通过API接入（如fine-tuned OpenAI模型或本地LoRA模型）。因此，通过外部微调和RAG插件，可在一定程度上增强生成的个性化和知识性。

    已知优点：酒馆功能强大、可定制性高，对话配置灵活，支持多模型、多模态（文字/语音/图像）交互。界面用户友好度较高，社区活动丰富，有大量现成角色卡和提示词模板可用。作为本地工具，无须付费API即可使用（可接免费模型），且不收集数据。其插件系统和脚本接口为创作者提供了无限扩展潜力。

    已知局限：由于功能丰富，酒馆的学习曲线较陡，普通用户需要时间配置角色卡和参数才能获得满意效果。不擅长为连贯小说创作定制（更偏向即时对话角色扮演），缺少面向长篇叙事的结构化工具。它本身不提供自动化情节一致性检验、拼写检查或语法校正等写作专用功能，需要用户自行实现或借助其他工具。多用户协作和权限控制缺失，不适用于多人在线共同创作。另由于依赖接入的LLM，输出质量受模型能力限制，有时会出现角色跑偏或生成无关内容等问题。

3. 开发流程与小说创作流程的映射

我们将软件开发/DevOps流程中的关键概念逐项映射到小说创作流程，以帮助构思“小说创作管道”。下表展示了主要概念的对应关系和示例：
开发/DevOps 概念	对应小说创作流程概念	示例/说明
需求分析	故事大纲/概要规划	明确小说主题、世界观、角色线等，产出故事提纲。
UI/UX 设计	角色设计 / 世界观设计	设计主要角色特征、背景、场景风格等，绘制人物关系图或场景地图。
编码实现	章节撰写与场景创作	根据大纲写作各章节内容，实现情节和对话。
单元测试	情节一致性检查	对每个场景/章节进行自动或人工检查，保证角色动机和情节连续性。
集成测试	整体故事验证	检查全书连贯性（伏笔呼应、世界观自洽等），如同回归测试。
代码审查/评审	同行评审/编辑审稿	其他作者或编辑对章节内容进行审读，提出修改建议。
CI (持续集成)	自动化回归校验	引入自动检查工具（AI检测情节冲突、句法错误等），每次章节迭代都自动执行。
CD (持续交付)	章节连载发布	将完成内容按计划定期发布到连载平台或网站，自动化推送。
部署发布	出版发布	正式发布小说出版物或电子书，上线平台供读者阅读。
版本控制	文稿版本管理	使用Git或文档版本工具记录各稿件版本历史，支持分支（不同结局/分支情节）。
回滚机制	回退到旧版本	如发现新章节问题，可恢复到之前的版本或重新编辑旧章节。
监控/日志	读者反馈与行为分析	收集读者评论、点击率、停留时长等数据，监控故事受欢迎程度和问题。
性能/质量指标	写作质量和进度指标	如每日写作字数、读者评分、章节完成率、错误率（错别字、剧情bug数）等。
敏捷迭代/Sprint	写作迭代/连载周期	每期（如每周）计划写作目标（章节数、字数），完成后评审并调整下一阶段计划。

上表映射清晰地将产品开发流转化为小说创作环节。例如，需求分析生成《创作大纲》相当于确定故事功能和模块；单元测试类似对每幕剧情进行一致性校验；持续集成/持续交付（CI/CD）对应自动化校验机制与章节自动发布；监控则对应分析读者反馈数据。

下面的流程图也直观展示了开发流程与创作流程的对应关系（箭头表示对应映射）：

小说创作流程

DevOps_流程

需求分析

系统/架构设计

前端实现

单元测试

集成测试

部署上线

运维监控

创作大纲/需求

角色/场景设计

章节撰写

情节校验（单元测试）

整体故事审校

连载发布

读者反馈监控

4. “AI Harness” 框架设计

基于上述映射，我们设计一个AI Harness 框架来系统化支撑AI辅助的小说创作流程。框架主要模块和功能职责如下：

基础设施

发布与监控

模型与评估

创作与协作

创作管理

版本控制

提示词库

审稿/协作

模型调度

评估/测试套件

自动化流水线

回滚机制

发布与监控

插件/扩展接口

数据隐私与合规

    创作管理（CM）：提供故事项目和章节管理界面。作者在这里创建/编辑章节，管理故事大纲和角色档案。支持富文本编辑与AI调用按钮。职责包括：组织章节顺序、存储章节草稿、记录创作进度等。技术建议使用现代前端框架（如React、Vue），并集成文本编辑器（TipTap、ProseMirror）和任务管理工具（可内置日程表/待办）。可替代方案：简易文档工具（Markdown编辑+Git），缺点交互性弱。

    版本控制（VC）：负责对创作内容进行版本管理和分支。建议使用Git等分布式版本控制系统，将各章节和角色卡内容存储在代码仓库中。接口提供提交、回退、分支管理功能。关键技术：Git + 图形化界面（如GitBook或自建UI）。备选：基于数据库记录版本历史，但灵活性和社区支持不如Git。优势是强大的回滚和协作能力；劣势是对不熟悉Git的作者有学习成本。

    提示词库（PL）：集中管理所有AI提示词和角色卡模板。应提供分类、搜索、编辑和复用功能，让作者快速调配系统提示、世界观、角色个性模板等。技术选型可用数据库（如MongoDB）或文件系统（YAML/JSON）配合前端UI。可参考语言链（LangChain）中的提示管理模式。备选方案：纯文件夹+命名约定简单但缺少管理工具；优点是灵活，缺点是搜索不便。提示词库接口需与模型调度模块集成：当生成请求触发时，将相应提示组合传给MS。

    模型调度（MS）：负责AI模型的调用与资源调度。接收生成任务（如“生成第3章”），从提示词库和创作管理获取上下文并拼装提示，然后调用指定模型API。支持本地服务（Hugging Face模型、Oobabooga）和云API（OpenAI、Anthropic等）。建议使用微服务/队列架构：可用 Python+FastAPI 或 Node.js + Express 写后端服务，结合Celery/RabbitMQ或Kubernetes Job进行异步调度。关键技术包括：多模型管理（OpenAI API、自定义LLM引擎）、并行任务队列、资源监控。可替代：直接在前端调用API，缺点是暴露密钥。MS接口需与评估套件和流水线对接，确保模型输出能被后续环节处理或回滚。

    评估/测试套件（ES）：对生成文本进行自动化质量检测。功能包括：语法拼写检查（如集成LanguageTool）、情节一致性校验（自定义规则或AI审查）、风格/可读性评分、敏感内容过滤。可使用现有NLP工具或训练小模型来自动打分。该模块为CI流水线的一部分，在每次章节生成后运行，输出质量报告。选择可扩展：简单可用开源工具实现基本检查；高级可用训练定制模型（如GPT根据提示进行自评）。优点是提升稿件质量，缺点是依赖配置和误报概率。

    自动化流水线（AP）：类似软件CI/CD管道。编排整个创作流程：触发生成（如章节撰写任务）、调用模型、执行评估测试、通知作者审核、最终发布。技术可选用CI工具（Jenkins/GitHub Actions）或专用编排（Apache Airflow、Argo Workflows）。流水线接口负责串联MS、ES、发布模块等，确保输出符合标准后自动推进。如果任一步骤失败，则停止并回退到安全状态（如退回上次版本）。备选：自己写脚本串联，灵活但维护复杂。流水线最大优点是自动化和可追溯；缺点是配置和管理成本增加。

    审稿/协作（RC）：支持多人审阅、评论和协作创作。功能类似代码审查工具（Code Review），但面对文字稿件。应提供评论、高亮标注、任务分配等功能，以及在线多人编辑（可参考Google Docs或Notion的协作模式）。技术可用实时协作编辑引擎（Yjs、ShareDB）和权限管理。备选：使用现有协作平台（Notion、GitBook），集成难度低但不易自定义。作用是提高创作质量和团队协同效率。

    发布与监控（PM）：负责将完成的章节发布到目标渠道（如电子书平台、网站），并收集读者反馈数据。发布接口可以集成CMS（如WordPress API）或按需生成电子书/PDF。监控功能包括统计阅读量、评论、点赞等用户行为指标，并可视化展示给作者。技术选型可用ELK/Grafana或BI工具处理日志和分析。关键接口：向第三方平台的发布API，对接分析工具。备选方案：简单导出文件后手动发布，自动化程度低。

    回滚机制（RB）：针对评估失败或发布后发现问题时，能够恢复到前一版本。接口与版本控制紧密结合，在发布前后支持自动回退（如Git回滚、数据库快照）。技术可利用Git revert或保存发布前快照。此模块责任是保证内容安全，避免因错误发布造成用户体验问题。

    插件/扩展接口（API）：提供开放的扩展点，允许第三方开发插件或服务。例如外部内容检索（检索增强）、视觉辅助（自动生成插图）、语音合成、社交分享等。设计统一的API注册机制（可参考瀑布流用Webhook或插件市场），并为插件执行隔离。重点接口：事件钩子（章节生成完成、发布前后等）和数据访问（读取提示词、写回日志）。可选方案：仅支持脚本式自动化（如STScript），优点简单但扩展性弱。公开接口最大优点是生态灵活，缺点是安全和兼容性需管理。

    数据隐私与合规（DP）：确保用户创作数据和模型接口符合隐私与版权法规。职责包括：提供用户数据加密存储，敏感信息脱敏；记录合规协议（如GDPR）和授权模式；处理AI生成内容的版权归属记录。技术方面可使用加密库、审计日志系统、访问控制和隐私合约。备选方案：全本地部署（无需合规外包），缺点是用户自行承担法律责任。该模块关键性在于防范AI创作中的版权纠纷和保护个人数据。

每个模块都需要明确职责和接口。例如，“模型调度”模块应提供REST API供“创作管理”模块调用（输入当前场景和提示列表，返回生成文本）。“评估测试”模块应接受文本输入并返回评估得分和建议。各模块间可通过REST或消息队列解耦。关键技术选型建议：前端可使用React/Vue构建富文本编辑和仪表盘；后端推荐Node.js或Python Flask/FastAPI；CI/CD流水线可基于Jenkins/GitHub Actions；监控可用Prometheus/Grafana；数据库可选PostgreSQL或MongoDB存储文档和提示词。整体可架构为云原生微服务架构，便于扩展和维护。
5. 可行性评估
5.1 技术可行性

    AI模型能力：当前大语言模型（GPT-4、Gemini等）在生成高质量文本方面已有显著提升，可胜任故事创作的初稿生成。但复杂长篇叙事需要较大上下文窗口或分段生成，目前有一定局限（上下文消失、逻辑混乱）。可行的补偿方式包括使用RAG和分层记忆机制。总体而言，技术上可用API集成或本地开源模型实现自动生成功能。
    开发运维：框架所需技术多数已有成熟开源方案（提示词管理、版本控制、CI/CD、监控、前后端框架等均成熟）。构建该系统并不涉及未知核心技术。运行层面需考虑LLM调用延迟和并发成本，可通过异步队列和GPU资源扩展来应对。
    数据需求：若要进一步自研个性化模型或测试套件，需大量标注数据（如情节连贯性标签、语法正确性数据等）。这部分投入较大。可先依靠已有公共工具和社区资源（例如GPT-4评估、语言模型模板）降低标注成本。

5.2 产品可行性与用户体验

    目标用户：目标群体为有创作需求的写作者、作者社群以及内容创作平台。AI助手应该提供提效而非完全替代，以避免用户抗拒。首先面向有AI尝试意愿的科幻、奇幻小说作者等细分群体。
    功能卖点：快速生成创意梗概、章节草稿，自动校对一致性，多人协作工具等都是吸引点。若产品定位模糊或体验复杂（如SillyTavern有陡峭学习曲线），易导致用户流失。需简化UI、提供模板示例和引导，以降低上手难度。
    风险：AI生成内容易出现不合适或低质量片段，需人工介入修改。若错误频繁、人工修正率高，会降低产品吸引力。用户体验风险包括对AI依赖过强导致创作风格不统一，或对生成内容的版权不确定性感到担忧。产品需明确提示原创程度和引用规则。

5.3 商业模式

    盈利方式：可采用订阅制或付费功能。B端可向出版社、内容创作公司提供白标解决方案；C端则可按生成功能付费（如超额API调用、专属模型微调服务）。也可考虑与写作平台合作，提供嵌入式写作助手。
    市场需求：已有部分AI写作工具（如文心一言、ChatGPT）用于辅助写作，但缺乏整合式的创作流程管理平台。若做好用户教育和市场推广，可吸引早期写作者。估算目标市场：目前中文网络作家约百万级规模，取0.1%用户使用AI辅助工具，每月活跃作者数（MAU）约千人级别可预期。
    运营成本：主要为服务器和模型调用成本。若使用OpenAI等云API，每万字调用成本数十美元（以GPT-4接口计）；或部署本地模型，需投入GPU资源（如NVIDIA A100每小时数美元）。综合来说，若服务数百用户，月成本可能在数千至数万美元不等，需通过订阅或增值服务覆盖。

5.4 数据与标注成本

    训练数据：若未来需为特定风格微调模型，需要海量小说文本，这部分版权需注意。初期可用公开领域或用户自有文本训练。
    评估数据：构建自动评估工具需标注大量示例（如情节评价、逻辑一致性标注），这需要投入时间和人力。可先使用已有语言模型进行伪标注，再人工审核。
    标注成本：若团队内置编辑人员做标准化标注，成本与内容量成正比。可以考虑众包或众议模式降低成本。

5.5 性能瓶颈与极限

    创作质量上限：AI目前较擅长短文本和复合任务，但长篇连贯创作还需更多迭代。预计通过不断优化提示和使用记忆模块，可使质量逐步提升，但完全自动化质量可能始终落后于资深人类作者。
    自动化程度上限：因写作带有创造性和情感成分，完全无需人工干预的自动写作难度很高。实际应用中，需要人工制定大纲和审核生成内容，自动化比例可能在50%～80%之间。
    关键指标（示例估计）：假设初期每月活跃作者数可达1,000人，平均每人每月生成5-10章；章节生成速度取决于模型大小，以GPT-4为例，一次API请求可生成~3000字（约3000token），耗时几秒，故每章节生成时间可控制在<1分钟。人工干预率（需要修改比率）可假设为30%-50%（即约半数AI输出需润色）。成本方面，若每万token成本0.02美元，一个50k字小说大约1美元；若用户自带模型成本可大幅降低。

综上，该方向在技术上可行，核心功能可由现有工具与模型集成实现，但需重点解决写作质量保证、用户体验和版权合规等问题来确保产品可行并有竞争力。
6. 实施路线图

    MVP 阶段（第1～3个月）：实现核心功能的最小可行产品。包括：章节编辑器（前端）、基本提示词库和角色卡系统、与至少一种LLM模型（如GPT API）的集成、简单的版本历史记录和查看功能、基础自动化流水（调用模型并插入生成结果）。重点展示AI自动续写能力和大纲生成。不要追求完善的评估和协作功能，仅需示例演示。所需资源：1名前端、1名后端开发，共2-3人。
    里程碑：完成可登录的网页/桌面编辑器，支持新建章节、调用AI生成段落、保存编辑内容；演示至少两种角色卡场景（如人物对话、环境描写）。
    Beta 阶段（第4～9个月）：引入自动化质量回归与协作功能。实现评估测试套件（拼写检查、基础逻辑校验）、CI流水线自动化（章节生成后自动运行检查）、基础的多人协作编辑（例如评论功能）、发布接口（能够导出电子书或上传到测试服务器）和读者反馈收集原型。扩展模型支持（多模型选择、本地部署选项）。重点与少量真实用户（写作者）进行测试，收集反馈优化UI/UX。团队扩充至4-5人，包括QA和产品经理。
    里程碑：成功发布测试版给封闭用户群，收集反馈；实现章节审稿流转（作者→编辑→发布）；生成内容质量通过自动检查，并能及时回退错误版本。
    1.0 版本（第10～18个月）：全面上线功能、性能优化和商业化准备。完善监控分析模块、插件市场、权限管理和合规功能。增强RAG检索（知识库编辑工具）、支持更多创作场景（诗歌、剧本等模板）。大幅优化UI易用性、响应速度和系统稳定性。开始付费用户招募和营销。整个团队规模可达5-8人，包括市场/运营人员。
    里程碑：正式发布1.0版本，具备完整核心模块；至少百名注册用户并开始产生营收；发布对外产品文档和营销材料。

各阶段应设置迭代周期（Sprint），每月发布新功能或修复，并持续评审产品效果。路线图需保持灵活，根据用户反馈和技术进展调整优先级。
7. 关键风险与缓解策略

    模型输出质量风险：AI可能生成逻辑混乱、重复或不当内容。缓解：建立严格的自动化评估与人工审核流程，引入“人工in-the-loop”；持续优化提示策略，使用RAG和记忆机制提升连贯度。
    用户体验风险：复杂功能可能导致用户迷失或抗拒。缓解：在产品早期聚焦核心价值（如自动续写和校对），简化界面，引导用户从案例入手（内置教程、示例项目）。做好客户培训和文档支持。
    版权与伦理风险：AI生成内容或使用训练素材存在侵权可能。缓解：严格遵守版权法和平台规定，提示用户审查AI输出；提供版权声明或风险提示；在数据隐私模块记录输出来源；禁止将受版权保护作品直接作为训练/提示素材。
    商业可持续风险：成本高昂可能难以盈利。缓解：灵活使用成本较低的本地模型或API组合（如微调专用小模型），并制定合理的收费模式。拓展增值服务（如个性化微调、大规模部署）。
    技术难题：如长文本处理瓶颈、系统性能瓶颈。缓解：评估新兴架构（如分布式推理、流水线微分段生成），提前进行性能测试与优化，动态扩容资源。
    团队与资源风险：高级AI/DevOps人才难寻。缓解：借助开源社区资源，或与科研机构/高校合作；采用外包+内部开发的混合模式降低成本。

待调研问题清单及优先级（示例）

    最佳创作模型选型：评估不同大模型在故事生成质量和速度上的差异（优先级：高）。
    自动评估指标体系：确定可量化的故事质量评估方法（如一致性、创意分数）（优先：高）。
    用户需求调研：写作者在创作流程中的痛点和真实需求调查（优先：高）。
    版权合规实践：行业内已有的AI创作版权判定与合规方案（优先：中）。
    市场与竞争分析：同类AI写作产品现状与商业模式研究（优先：中）。
    持续反馈机制：设计在线读者反馈收集与分析系统（优先：中）。
    多语言/跨文化支持：后期是否扩展到其他语言或文化背景创作（优先：低）。

每项问题应安排专门时间和负责人进一步调研，以逐步降低风险。

参考文献：以上内容综合了行业白皮书、官方文档、学术博客等资料。具体方案需结合实际用户测试和持续迭代优化。

### User
有没有人做过类似的东西呢

### Assistant
答案是：**有，而且从 2025 年开始越来越多。** 但真正做到你说的那个方向——**把软件工程 / DevOps 的思想完整迁移到 AI 小说创作**——目前还没有成熟产品。

实际上我搜了一圈，现在大概可以分成四类。

---

# 第一类：Story Bible（最接近，但是只有 Config，没有 Workflow）

代表：

- urlStorybible
- Sudowrite Story Bible（商业产品）

它们解决的问题是：

```
小说
│
├── 人物
├── 世界观
├── 地图
├── 时间线
├── Plot
├── Relationship
└── AI Context
```

AI 永远不是直接吃全文。

而是：

```
Scene

↓

Retriever

↓

Character
Location
Timeline
Rules

↓

LLM
```

其实就是

> Story Bible = RAG Database

和软件开发里面

```
API Docs
↓

Retriever

↓

LLM
```

完全一样。

---

但是它没有：

- CI
- Review
- Testing
- Diff
- Agent Workflow

只是数据库。

所以离 Harness 很远。

---

# 第二类：Novel-OS

这个我觉得你一定会喜欢。

GitHub：

urlNovel-OS

它直接把小说写成：

```
.novel-os

standards/

novel/

manuscripts/

tasks/

decisions/
```

甚至还有

```
Standards

↓

Novel

↓

Manuscripts
```

三层 Context。

官方自己都说：

> Transform AI from confused assistant to trusted writing partner.

---

它其实已经开始借鉴软件工程。

例如：

```
Writing Standards

≈

Coding Standards
```

```
Novel Decisions

≈

ADR (Architecture Decision Record)
```

```
Writing Tasks

≈

Issues
```

```
Story Outline

≈

Architecture Design
```

---

但是仍然缺：

- 自动流水线
- Agent 编排
- 自动检查
- 自动修复

所以更像：

> Prompt Template + Directory Structure

---

# 第三类：Agent Pipeline

这一类开始有 Harness 的味道。

例如：

urlNovelWriter

里面已经有：

```
Story Generation Agent

↓

Consistency Agent

↓

Quality Agent

↓

Writing Agent

↓

Review Agent
```

甚至还有：

```
Retry Logic

Quality Dashboard

Trend Analysis
```

官方结构：

```
agents/

consistency/

quality/

review/

writing/
```

几乎就是：

```
CI Pipeline
```

搬过来了。

---

还有

Nous Research

Autonovel：

urlautonovel

官方描述直接写：

> autonomous pipeline

而且流程：

```
Seed

↓

Foundation

↓

Review

↓

Loop

↓

Draft

↓

Revision

↓

Illustration

↓

Audiobook

↓

PDF
```

甚至：

```
score

↓

<7.5

↓

Regenerate
```

这已经很 DevOps 了。

---

# 第四类：社区玩家（最有意思）

Reddit 今年开始大量出现类似讨论。

大家几乎得出了同一个结论：

> **问题不是模型，而是 Workflow。**

很多人已经开始把小说当软件开发。

例如：

```
.story-bible

.style-guide

.context-pack

.scene-outline

.audit

.continuity-ledger

.chapters
```

甚至有人规定：

> No prose until scaffolding exists.

是不是很眼熟？

像不像：

```
No Deploy

Before Tests Pass
```

哈哈。

---

还有一个评论我特别认同：

他说：

> Canon 不应该放 Prompt，而应该放外部数据库。

是不是就是：

```
Code

!=

State

State

outside runtime
```

---

# 那有没有人做 "AI Harness"？

我认为：

**没有。**

注意：

不是没有小说 AI。

而是没有：

```
Novel Harness
```

概念。

现在基本都是：

```
Prompt

↓

LLM

↓

Output
```

或者

```
Agent

↓

Agent

↓

Agent
```

---

没人真正借软件工程这一整套：

```
Spec

↓

Plan

↓

Task

↓

Branch

↓

Commit

↓

Review

↓

Merge

↓

CI

↓

Regression Test

↓

Release
```

去写小说。

---

# 我反而觉得你的方向更像什么？

不是 Story Bible。

也不是 SillyTavern。

而是：

```
Cursor

+

GitHub

+

GitHub Actions

+

Jira

+

Claude Code

+

LangGraph

+

Story Bible

=

Novel Harness
```

换句话说：

不是：

> AI 小说软件

而是：

> **小说 IDE。**

---

如果再进一步，我甚至觉得应该是：

```
novel/

spec/

characters/

timeline/

world/

arc/

chapters/

tests/

agents/

workflows/

```

然后：

```
novel test
```

输出：

```
✓ Character consistency

✓ Timeline

✓ Foreshadow

✗ Alice 已死亡

Chapter 23 又出现

```

或者：

```
novel lint
```

输出：

```
POV Drift

Dialogue Drift

World Rule Conflict

Style Drift

```

甚至：

```
novel diff
```

可以看到：

```
Character

- timid

+ confident

```

然后要求 AI 自动分析：

> 是否符合成长弧线？

---

## 我对这个方向的判断

我认为这个方向**是可行的，而且价值点不在于“更会写”，而在于“更会管理”**。

目前市面上的产品几乎都集中在：

- 更好的模型
- 更好的 Prompt
- 更大的 Context

而真正长期创作的瓶颈，越来越被证明是**项目管理、知识管理、上下文切片、质量验证和自动化工作流**，而不是单次生成能力。

因此，如果把软件工程里的 **Git、CI、Lint、Test、ADR、Issue、Code Review、DevOps Pipeline** 系统性映射到小说创作，你做的就不是又一个 AI 写作工具，而更像是**AI 原生的长篇创作操作系统（Novel Operating System）**。

我觉得，这个定位比“AI 酒馆增强版”要大得多，也更有差异化。

### User
这里有多少部分可以用传统软件完成，有多少部分必须 LLM, 有多少部分会因为 LLM 导致不确定性导致出的效果有问题

我们假设传统技术：稳定可复现可靠，假设 LLM 技术不可靠，在此基础上怎么做到系统本身的健壮性和长期运行，以及长期的成本

### Assistant
这是一个非常好的问题，而且我认为**真正决定这个项目有没有价值的，不是 Prompt，而是系统架构。**

实际上，你可以完全借鉴现代软件工程里的一个原则：

> **把 LLM 当成一个不可靠的外部服务（Untrusted Service），而不是程序本身。**

就像今天的软件不会相信用户输入、第三方 API 或网络请求一样，也不要相信 LLM 的输出。

如果按这个思路设计，整个系统会清晰很多。

---

# 第一层：哪些应该完全由传统软件负责？

我的结论是：

**所有"状态（State）"都不应该由 LLM 管理。**

例如：

```
Project
 ├── Characters
 ├── Timeline
 ├── Locations
 ├── Chapters
 ├── Plot Graph
 ├── World Rules
 ├── Style Rules
 ├── Tasks
 ├── Draft Versions
 └── Metadata
```

这些都应该存在数据库里。

例如：

```
Character

id
name
age
alive
occupation
hairColor
eyeColor

Relationship

A
B
trust
love
hate

Timeline

timestamp
location
event

Location

weather
population
owner

Knowledge Graph
```

这些都可以：

- SQLite
- PostgreSQL
- Neo4j
- JSON
- Git

LLM根本不用管理。

---

例如：

AI说：

```
Alice 今天死了。
```

系统不会直接接受。

而是：

```
Draft

↓

Parser

↓

Character Event

↓

Transaction

↓

Database
```

然后：

```
Character.alive=false
```

以后所有Agent都读取数据库。

不是Prompt。

---

所以：

> 世界观应该是数据库。

不是Prompt。

---

# 第二层：哪些适合做规则引擎（Rule Engine）

其实非常多。

例如：

## Timeline

```
Chapter1

Monday

↓

Chapter5

Sunday
```

如果：

```
Tuesday
```

突然变：

```
Monday
```

Rule Engine：

```
Timeline Conflict
```

不用AI。

---

例如：

年龄：

```
出生：

1998

故事：

2001

年龄：

27
```

Rule：

```
Wrong

Expected=3
```

不用AI。

---

例如：

人物：

```
Alice

alive=false
```

Chapter：

```
Alice walked in.
```

Parser：

```
Entity=Alice

alive=false

↓

Error
```

不用LLM。

---

例如：

世界规则：

```
Magic banned
```

Chapter：

```
Normal person casts spell
```

Rule：

```
Forbidden
```

不用LLM。

---

这种东西其实就是：

```
Lint
```

---

# 第三层：哪些适合图算法

例如：

角色关系：

```
A

↓

B

↓

C
```

发现：

```
A

↓

B

↓

A
```

或者：

```
King

↓

Father

↓

Son

↓

King
```

循环关系。

Graph直接查。

---

例如：

剧情依赖：

```
Chapter20

depends

Chapter5
```

Chapter5删掉。

Graph：

```
Broken Dependency
```

---

例如：

伏笔：

```
Chapter3

Gun
```

后面：

```
Never Mentioned
```

Graph：

```
Unresolved Foreshadow
```

不用LLM。

---

# 第四层：哪些属于编译器（Compiler）

我甚至觉得：

小说应该有AST。

例如：

```
Scene

↓

Paragraph

↓

Dialogue

↓

Action

↓

Thought

↓

Description
```

不是：

```
一大坨文字
```

而是：

```
Dialogue

speaker

content
```

例如：

```
Alice：

Hello.
```

Parser：

```
Dialogue

speaker=Alice

text=Hello
```

以后：

```
Character Frequency

POV

Emotion Curve
```

都可以统计。

不用AI。

---

# 第五层：哪些必须LLM

真正必须LLM的其实没有那么多。

例如：

### 创意

```
下一章应该发生什么？
```

必须。

---

例如：

润色

```
Rewrite
```

必须。

---

例如：

对白

```
Generate Dialogue
```

必须。

---

例如：

情绪描写

```
Describe sadness
```

必须。

---

例如：

风格迁移

```
Write like Tolkien
```

必须。

---

例如：

章节扩写

```
Outline

↓

3000字
```

必须。

---

所以：

LLM主要负责：

```
Natural Language Generation
```

而不是：

```
Project Management
```

---

# 第六层：哪些最好LLM+Rule Hybrid

这是最大的一块。

例如：

```
Alice

很害羞
```

这一章：

```
Alice 冲进去骂人。
```

Rule不知道。

AI知道。

于是：

```
Character Checker Agent
```

输出：

```
Possible Personality Drift

confidence=0.74
```

不是Error。

而是Warning。

---

例如：

```
文风变化
```

Rule做不了。

AI可以：

```
Style Drift

82%
```

---

例如：

伏笔：

```
枪

是否已经回收？
```

AI比Rule强。

---

例如：

节奏：

```
连续五章都是聊天。
```

AI知道。

Rule不知道。

---

# 第七层：哪些绝不能相信LLM

例如：

AI：

```
Alice已经死了。
```

系统：

```
Database

alive=true
```

相信谁？

必须：

```
Database
```

---

AI：

```
John 是哥哥。
```

DB：

```
John 是弟弟。
```

相信谁？

DB。

---

所以：

LLM：

```
Read-only
```

不能直接改状态。

只能：

```
Proposal
```

例如：

```
Proposal

Change:

alive=true

↓

false
```

然后：

```
Validator

↓

Commit
```

是不是很像Git？

---

# 第八层：如何降低LLM的不确定性

这里可以借鉴软件工程里的"多层防线"：

```
          User
            │
            ▼
      Intent Planner（LLM）
            │
            ▼
  生成"结构化提案"（JSON/DSL）
            │
            ▼
 Schema Validator（传统软件）
            │
            ▼
 Rule Engine（传统软件）
            │
            ▼
 State Update（数据库）
            │
            ▼
 Narrative Generator（LLM）
            │
            ▼
 Consistency Checker（LLM + Rule）
            │
            ▼
 Git Commit / Version Snapshot
```

这里有几个关键原则：

- **LLM 尽量输出结构化数据，而不是直接修改系统。**
- **所有状态变更都经过验证。**
- **任何一步失败，都可以回滚到上一个版本。**
- **LLM 是建议者（Advisor），不是最终裁决者（Authority）。**

---

# 第九层：长期运行与成本控制

如果按你的 Harness 思路，长期成本更多来自**调用次数**而不是单次上下文长度，因此重点应放在"减少不必要调用"。

可以采用类似编译器的增量思想：

- **增量上下文**：只给模型当前章节、相关角色、相关地点、相关时间线，而不是整个小说。
- **缓存（Cache）**：同一段分析结果（如角色画像、章节摘要）不重复生成。
- **分层模型**：
  - 小模型：分类、实体提取、摘要、简单检查。
  - 大模型：创意生成、重写、复杂一致性分析。
- **事件驱动**：只有当角色设定、世界规则或章节内容发生变化时，才重新运行相关检查，而不是全量扫描。

---

# 如果把整个系统按"传统软件 vs LLM"划分

我会给出一个大致比例（按系统能力，而不是代码量）：

| 模块 | 最佳实现方式 |
|------|-------------|
| 数据存储（角色、世界观、时间线、版本） | 100% 传统软件 |
| 工作流调度、任务队列、权限、版本控制 | 100% 传统软件 |
| 规则校验（时间、年龄、实体引用、约束） | 90% 传统软件 |
| 检索、索引、依赖图、知识图谱 | 95% 传统软件 |
| 创意生成、对白、描写、扩写 | 95% LLM |
| 文风一致性、人物性格漂移、叙事质量 | LLM 为主，规则辅助 |
| 最终状态确认、版本提交 | 100% 传统软件 |

我的判断是，一个成熟的 **Novel Harness** 应该只有大约 **20%～30% 的核心能力依赖 LLM**，而 **70%～80% 应由传统软件工程保证确定性、可复现性和长期维护性**。

这也是我认为这个方向最有潜力的地方：**LLM 负责"创造内容"，传统软件负责"管理系统"。** 软件工程提供的是可靠的骨架，而 LLM 只是其中一个可替换、可升级、甚至可并行验证的智能组件。这样的架构不仅更稳定，也更容易随着模型进步而持续受益，而不会因为模型的不确定性而失去整个系统的可控性。

### User
但是小说的元素是非常多样化的，我们怎么样做到完整呢

比如我们先生产一个大纲，然后我们定义一些角色

但是可能会引入路人等，也可能会有主角视角，不同的视角，明暗线，这些结构非常复杂，我们怎么去描述呢？

我希望引入一个描述情节的稳定中间结构？

### Assistant
我觉得你已经碰到**这个方向最核心的研究问题了。**

实际上，我认为真正要发明的不是 Workflow，而是：

> **Novel IR（Intermediate Representation，小说中间表示）**

这和编译器的发展历史非常像。

---

## 软件为什么需要 IR？

最开始程序就是：

```
C

↓

机器码
```

后来发现：

- 不方便优化
- 不方便分析
- 不方便跨平台

于是出现：

```
C

↓

AST

↓

LLVM IR

↓

Machine Code
```

LLVM IR 最大的意义不是运行。

而是：

> **所有工具都围绕 IR 工作。**

例如：

```
Lint

Optimizer

SSA

Data Flow

CFG

Debugger

Profiler
```

全部不用理解 C。

只理解 IR。

---

## 小说其实也一样

今天所有 AI 都是：

```
Prompt

↓

文字

↓

Prompt

↓

文字
```

所以：

没有稳定状态。

没有 Diff。

没有 Analysis。

没有 Test。

因为：

**文本不是一个好的中间表示。**

---

# 小说真正的 IR 应该长什么样？

这里我自己的观点比较激进。

**小说不是一串文字。**

而是：

> **世界状态（World State）的连续变化。**

例如：

```
Scene

↓

发生了一些 Event

↓

Event 修改 World State

↓

LLM 描述 Event
```

也就是说：

```
小说

≠

文字

小说

=

State Transition
```

---

举个例子。

原文：

> Alice 推开门，发现 Bob 已经死了。

传统 AI：

```
Prompt

↓

Sentence
```

Novel IR：

```
Scene

Event1

Actor:
Alice

Action:
OpenDoor

Target:
Room
```

```
Event2

Actor:
Alice

Observe:
Bob

State:

dead=true
```

注意。

这里：

**没有文学。**

只有：

```
State
```

然后：

AI 去负责：

> 如何描写。

---

# 这样最大的好处是什么？

例如：

AI 写：

```
Bob站了起来。
```

IR：

```
Action

Actor=Bob

StandUp
```

Validator：

```
Bob.dead=true

↓

Error
```

不用 AI。

---

## 那么"路人"怎么办？

你刚刚提的这个问题特别关键。

其实：

**不要预定义所有角色。**

而是：

```
Entity Registry
```

任何：

```
张三
```

第一次出现：

Parser：

```
Unknown Entity
```

自动：

```
NPC_342

Type:

Human

Importance:

Temporary
```

以后：

如果：

```
再次出现
```

升级：

```
Named Character
```

是不是很像：

```
Compiler Symbol Table
```

---

# 那 POV 怎么办？

其实 POV 也是：

State。

例如：

```
Scene

POV:

Alice
```

于是：

Validator：

```
这一章：

Alice 不可能知道：

Bob 私下做什么。
```

是不是：

静态检查。

---

# 明线暗线怎么办？

我觉得：

不要叫：

```
Plot
```

而叫：

```
Thread
```

例如：

```
Thread:

Revenge
```

包含：

```
Scene3

Scene10

Scene22
```

还有：

```
Progress:

40%
```

另一条：

```
Love
```

```
Scene5

Scene8

Scene20
```

其实：

就是：

Git Branch。

---

# 那伏笔呢？

也是：

一种 Thread。

例如：

```
Foreshadow

Gun
```

```
Introduce:

Scene3
```

```
Resolve:

Scene18
```

如果：

```
没有 Resolve
```

CI：

```
Warning
```

---

# 人物成长怎么办？

我甚至觉得：

应该：

不是：

```
Character
```

而是：

```
Character State Timeline
```

例如：

Alice：

```
Confidence

0.2

↓

0.5

↓

0.9
```

Trust：

```
Bob

0.1

↓

0.8
```

Morality：

```
0.9

↓

0.6
```

于是：

AI：

生成对白。

读取：

```
Confidence=0.2
```

而不是：

Prompt：

```
Alice 比较害羞……
```

---

# 世界观怎么办？

世界规则。

例如：

```
Magic

Allowed=false
```

```
Teleport

Need:

Mana>100
```

Rule。

不是 Prompt。

---

# 那真正复杂的是哪里？

其实不是：

角色。

不是：

时间线。

而是：

> **情节。**

因为：

```
Alice 去了学校。
```

到底意味着：

什么？

这是：

语义。

---

所以。

我觉得：

Novel IR 应该：

不是：

文本。

也不是：

JSON。

而是：

```
Scene

↓

Intent

↓

Events

↓

Effects
```

例如：

```
Goal:

Alice

Find Father
```

```
Conflict:

Guard Stops
```

```
Decision:

Bribe
```

```
Outcome:

Enter Castle
```

这些：

比文字稳定得多。

---

# 我甚至会再往上一层

其实：

Scene 本身：

也不是单位。

真正单位应该：

叫：

```
Narrative Transaction
```

例如：

```
Transaction

Precondition

Action

Effects

Postcondition
```

是不是很像：

数据库。

例如：

```
Pre

Alice Alive
```

```
Action

Fight
```

```
Effect

HP-30
```

```
Post

Bob Dead
```

然后：

LLM：

把这个：

变成：

3000 字。

---

# 我觉得真正值得研究的是"Novel IR"

如果让我重新设计整个系统，我不会从 Prompt 开始，而会从一个能够承载叙事语义的中间层开始。它既不像最终小说那样充满文学表达，也不像数据库那样只有字段，而是介于两者之间——足够结构化，能够被程序分析、验证、版本化，又保留叙事所需的信息。

我目前设想，它至少会包含四类对象：

- **世界状态（State）**：角色、地点、物品、规则、时间等所有可验证的事实。
- **叙事事件（Event）**：谁在什么条件下，对什么对象执行了什么行为，以及它带来了哪些状态变化。
- **剧情线程（Thread）**：主线、支线、伏笔、人物成长线、情感线等跨场景持续演化的目标和约束。
- **场景意图（Scene Intent）**：这一场戏为什么存在，它要推进哪条剧情线程、改变哪些状态、给读者传递什么信息。

这样，LLM 不再直接"写小说"，而是**把 Novel IR 渲染成自然语言**；传统软件则负责维护 IR 的一致性、版本、依赖和验证。

---

## 不过，我觉得还需要再迈出一步

即使是上面的 IR，仍然**过于偏"数据模型"**，而没有真正抓住叙事学。

如果你的目标是做一个类似 LLVM 之于编程语言的 **Novel Harness**，我建议下一步不要急着设计 JSON 或数据库，而是先回答一个更根本的问题：

> **一本小说，在"不考虑文字表达"的情况下，最小不可再分的叙事单元到底是什么？**

编译器有 AST 节点，数据库有事务，React 有 Fiber，Git 有 Commit。

小说也应该有一个类似的"原子单元"。找到它，你后面的 Workflow、CI、Lint、Diff、Agent 编排都会自然建立起来。

我的直觉是，这个原子单元**不会是章节（Chapter）、段落（Paragraph）或事件（Event）**，而更可能是一种"**叙事状态变迁（Narrative State Transition）**"：它描述的是**为什么世界发生了变化，以及这种变化对故事意味着什么**。

如果这个抽象足够好，那么你的项目就不只是"给 SillyTavern 加工作流"，而是在定义一种新的、可分析、可验证、可生成的**小说中间语言（Novel IR）**。这也是我认为这个方向真正具有研究价值的地方。

### User
还有什么现代小说用得上的技法，和他们发明出来的技法

现代文学有没有研究这方面的东西

### Assistant
有，而且**远比大多数 AI 创作者想象的丰富。**

不过有一个有意思的现象：

> **文学研究已经研究了 100 多年"小说是如何工作的"，但是 AI 社区几乎完全没有利用这些成果。**

AI 圈现在很多人在重新发明 Prompt、Story Bible、Memory，但文学理论其实早就有一套分析框架了。

我建议你不要只看 AI，而是把几个领域一起看：

- 文学理论（Narratology，叙事学）
- 编剧理论（Screenwriting）
- 游戏叙事（Game Narrative）
- 剧本工程（Script Engineering）
- 软件工程

你会发现它们能拼成一个 Novel Harness。

---

# 第一部分：叙事学（Narratology）

这是最值得研究的。

1970 年代以后几乎形成了一门完整学科。

他们研究的问题不是：

> 怎么写小说。

而是：

> 小说到底由什么组成。

例如：

---

## Story 和 Discourse

这是最经典的。

他们认为：

小说其实有两层。

```
Story
```

真正发生的事情。

例如：

```
Bob出生

↓

Bob长大

↓

Bob结婚

↓

Bob去世
```

这是：

Chronological Order。

---

但是：

小说写的是：

```
Bob去世

↓

Bob小时候

↓

Bob结婚

↓

Bob长大
```

这叫：

```
Discourse
```

也就是：

Narrative Order。

---

AI 今天几乎都混在一起。

实际上：

Story

应该是一棵 DAG。

而：

Discourse

只是 Render。

这和：

React

Virtual DOM

Render

非常像。

---

## Event

叙事学认为：

小说不是文字。

而是：

```
Event
```

例如：

```
Attack

Reveal

Meet

Escape

Death
```

不是：

```
"他缓缓推开门"
```

这是语言。

不是事件。

---

## State

更进一步：

事件只是：

```
State Transition
```

例如：

```
Before

Enemy

↓

Friend
```

事件：

```
Save
```

之后：

```
Friend
```

---

这是不是已经很像：

数据库事务。

---

# 第二部分：人物理论

现代文学其实已经开始把人物拆解。

例如：

E.M. Forster

提出：

Flat Character

Round Character

后来不断发展。

现在很多编剧课都会拆成：

```
Goal

Need

Fear

Lie

Wound

Arc

Motivation
```

例如：

Alice

```
Want

成为骑士
```

```
Need

学会信任别人
```

```
Lie

只有自己可靠
```

```
Fear

失去朋友
```

```
Arc

Selfish

↓

Selfless
```

你会发现：

这已经不是 Prompt。

而是一种状态机。

---

# 第三部分：Scene Theory

现代编剧研究 Scene。

Scene 不只是：

发生了什么。

而是：

每一个 Scene 都必须改变什么。

Robert McKee

John Truby

几乎都强调：

```
Value Shift
```

例如：

这一场：

```
Hope

↓

Despair
```

或者：

```
Trust

↓

Suspicion
```

Scene 就完成了。

---

所以：

Scene：

其实可以：

```
Input State

↓

Conflict

↓

Output State
```

---

# 第四部分：Beat

Hollywood 非常喜欢。

Beat：

不是章节。

而是：

最小剧情推进单位。

例如：

```
Alice敲门

↓

没人回应

↓

推门

↓

发现尸体

↓

震惊
```

五个 Beat。

不是一句。

---

所以：

Chapter

↓

Scene

↓

Beat

↓

Event

↓

State

---

# 第五部分：Dramatica

这个你一定要研究。

它几乎就是：

小说 UML。

他们甚至建立了：

完整数学模型。

例如：

Character：

不是：

人。

而是：

Function。

例如：

```
Protagonist

Antagonist

Reason

Emotion

Guardian

Sidekick

Skeptic
```

每个角色：

承担：

逻辑职责。

不是：

人物。

---

还有：

Story Mind。

整个故事：

就是：

一个人在思考。

这是非常神奇的理论。

---

# 第六部分：Hero's Journey

虽然老。

但是：

其实就是：

状态机。

例如：

```
Ordinary World

↓

Call

↓

Refuse

↓

Mentor

↓

Cross Threshold

↓

Trials

↓

Death

↓

Return
```

其实就是：

Workflow。

---

# 第七部分：Save the Cat

Hollywood 工业。

他们直接规定：

第几分钟：

必须发生什么。

例如：

```
Opening

Catalyst

Break into 2

Midpoint

Dark Night

Finale
```

其实：

Pipeline。

---

# 第八部分：Snowflake Method

这个更有意思。

它就是：

Top Down。

```
一句话

↓

一段

↓

一页

↓

角色

↓

章节

↓

Scene

↓

正文
```

是不是：

软件设计：

Architecture

↓

Module

↓

Class

↓

Method

↓

Code

---

# 第九部分：Story Grid

现代编辑很喜欢。

他们甚至给每一个 Scene 打标签。

例如：

```
POV

Conflict

Value Shift

Risk

Polarity

Object

Need
```

所以：

Scene：

其实：

已经有 Schema。

---

# 第十部分：Narrative Graph

近几年。

游戏行业开始大量研究。

例如：

Detroit

BG3

他们：

已经不用：

章节。

而是：

```
Narrative Graph
```

节点：

```
Scene
```

边：

```
Choice
```

其实：

DAG。

---

# 第十一部分：Interactive Fiction

这个和 AI 特别接近。

例如：

Twine

Ink

ChoiceScript

他们已经提出：

```
Storylet
```

概念。

Storylet：

就是：

```
Precondition

↓

Narrative Unit

↓

Postcondition
```

是不是：

Transaction。

---

# 第十二部分：Quest System

RPG：

已经研究很多年。

Quest：

其实：

```
Goal

↓

Tasks

↓

Completion

↓

Reward
```

小说很多：

也是 Quest。

---

# 第十三部分：Knowledge Graph

现代 NLP。

开始：

```
Entity

Relation

Event
```

这其实：

就是：

Story Bible

升级版。

---

# 第十四部分：Narrative Planning（AI 规划）

这是 AI 学术界最接近你设想的方向。

它并不直接生成小说，而是把故事看成一个**规划（Planning）**问题：

- 初始世界状态（Initial State）
- 角色目标（Goals）
- 可执行动作（Operators）
- 状态约束（Constraints）
- 目标状态（Goal State）

AI 通过搜索或规划算法生成一条满足约束的事件序列，再交给语言模型渲染。

它的思想和机器人路径规划、自动规划（Automated Planning）是一脉相承的。缺点是文学性较弱，但它提供了一种非常稳定的"骨架生成"方式。

---

# 我反而觉得，你真正应该研究的是"文学编译原理"

我一直有一个观点：

> **软件工程发明了 AST、CFG、SSA、LLVM IR，不是因为程序复杂，而是因为需要分析、优化和验证。**

小说同样复杂。

但文学理论过去更关注**解释作品**，而不是**构建可执行系统**。

因此，它提供了大量优秀的概念——Story、Discourse、Beat、Scene、Arc、Value Shift、Thread、POV、Storylet——却很少给出统一的数据模型。

而软件工程恰好擅长把复杂系统抽象成**可计算、可验证、可组合**的中间表示。

## 我认为最值得借鉴的，不是某一种理论，而是把它们融合起来

如果未来真的要做一个 Novel Harness，我不会照搬任何单一理论，而是把它们放在不同层级：

- **Snowflake Method**：负责从一句话逐步细化到章节，作为规划层。
- **Hero's Journey / Save the Cat**：负责宏观节奏，作为结构模板。
- **Narratology（Story / Discourse / Event）**：负责定义故事数据模型。
- **Story Grid / McKee**：负责 Scene 的质量检查和 Value Shift 验证。
- **Dramatica**：负责角色功能和多线叙事分析。
- **Interactive Fiction（Storylet）**：负责把每个叙事单元建模为带前置条件和后置条件的节点。
- **Narrative Planning**：负责自动规划和一致性验证。

这样，文学理论提供的是**叙事语义**，软件工程提供的是**系统工程能力**，LLM 则负责**语言生成和创造力**。

---

## 我建议再补充三个你可能会受益最大的研究方向

如果你准备把这个项目认真做下去，我认为有三个领域值得深入，它们与 Novel Harness 的契合度甚至高于传统 AI 写作：

1. **Narrative Design（游戏叙事设计）**：游戏行业比小说行业更早面对"复杂状态管理"，很多工具和思想可以直接迁移。
2. **Automated Planning（自动规划）**：研究如何在满足约束的前提下生成行动序列，这与剧情规划高度相似。
3. **Model-Driven Engineering（模型驱动工程）**：它的核心思想是"先建立领域模型，再自动生成实现"，与你提出的"稳定中间结构（Novel IR）"理念几乎完全一致。

我甚至认为，你最终要设计的东西，更像一个**叙事领域的领域特定语言（DSL）和中间表示（IR）**，而不是一个新的 Prompt 模板。那样它才能真正成为一个可以长期维护、验证、协作和自动化的创作平台。

### User
继续帮我确定有多少部分是必须 LLM 实现的，这样我可以探出系统可以做到的边界

### Assistant
这个问题非常关键，因为它决定了你的系统到底是：

1. **一个套 LLM 的写作工具**
2. **一个可靠的软件系统 + LLM 插件**
3. **一个新的小说编程语言 / 创作 IDE**

我倾向于第三种，但前提是你必须明确：

> **哪些能力属于“计算问题”，哪些属于“智能问题”。**

不要把所有困难都丢给 LLM。

下面我从小说生产全流程拆解。

---

# 总体结论先说

如果把一部长篇小说生产流程拆成 100%：

| 能力 | 传统程序 | LLM | 不确定性 |
|-|-|-|-|
| 项目管理 | 100% | 0% | 无 |
| 世界观存储 | 100% | 0% | 无 |
| 时间线管理 | 90% | 10% | 中 |
| 人物状态管理 | 80% | 20% | 中 |
| 剧情结构管理 | 50% | 50% | 高 |
| 剧情规划 | 30% | 70% | 高 |
| 文本生成 | 5% | 95% | 极高 |
| 文学质量评价 | 20% | 80% | 极高 |
| 创意 | 0% | 100% | 极高 |

最终：

> **真正不可替代的 LLM 部分，大概只有 30%-40%。**

剩余 60%-70% 可以工程化。

---

# 第一层：绝对不需要 LLM 的部分

## 1. 项目结构

类似 Git：

```
Novel Project

├── world/
├── characters/
├── timeline/
├── scenes/
├── drafts/
├── versions/
├── tests/
└── workflows/
```

完全传统软件。

---

## 2. 版本控制

比如：

```
Chapter 10 v1

↓

Chapter 10 v2
```

Diff：

```diff
- Bob 是医生
+ Bob 是军人
```

完全确定。

---

## 3. Entity 管理

角色：

```
Alice
{
 age: 20,
 alive:true
}
```

地点：

```
Castle
{
 owner:King
}
```

物品：

```
Sword
{
 owner:Alice
}
```

数据库。

---

# 第二层：可以完全程序化，但是需要 NLP

注意：

这里不是 LLM。

传统 NLP / 小模型即可。

---

# 4. 实体抽取

文本：

> Alice 进入森林。

得到：

```
Entity:

Alice
Forest

Event:

Enter
```

技术：

- NER
- Dependency Parsing
- Embedding

甚至小模型。

---

# 5. 时间抽取

文本：

> 三年前，Alice 离开王城。

得到：

```
Event:

Leave

Time:

Now - 3 years
```

可以。

---

# 6. 引用关系

例如：

> 她拿起剑。

"她"是谁？

传统 NLP 可以辅助。

但是复杂情况下：

LLM 更强。

---

# 第三层：规则系统可以做 80%

这里开始有意思。

---

# 7. Continuity Checker

检查：

## 年龄

数据库：

```
Birth:
2000

Scene:
2025
```

计算：

```
25岁
```

错误：

```
Character age mismatch
```

---

## 死亡检查

```
Death Event

↓

alive=false
```

后续：

```
Action:
Talk
```

Error。

---

## Location

```
Alice

Location:
Earth
```

Scene:

```
Mars
```

但是没有：

Transport Event

Error。

---

这些完全不用 AI。

---

# 8. Plot Thread 管理

例如：

主线：

```
Destroy Ring
```

状态：

```
Started

↓

Progress 30%

↓

Completed
```

程序管理。

---

# 9. Foreshadow 管理

例如：

```
Gun introduced

chapter 3
```

状态：

```
Unresolved
```

chapter 50:

```
Used
```

更新：

```
Resolved
```

---

# 第四层：必须引入 LLM 的地方

这里才是真正 AI。

---

# 10. Scene 意图理解

例如：

这句话：

> Alice 看着窗外沉默了很久。

程序知道：

```
Alice
Look
Window
```

但是不知道：

这是：

- 悲伤？
- 犹豫？
- 思考？
- 怀念？

需要 LLM。

---

# 11. Hidden State

小说最麻烦的地方：

**人物内心。**

例如：

角色：

```
表面:

愤怒

真实:

害怕失去朋友
```

数据库不知道。

LLM 可以推断。

---

# 12. Conflict Detection

例如：

Scene:

```
Alice:
我相信你
```

但是前面：

```
Alice:
怀疑 Bob
```

是不是冲突？

程序不知道。

LLM 判断。

---

# 13. 文学价值判断

比如：

这一章：

问题：

- 太平？
- 节奏慢？
- 情绪不足？
- 高潮不足？

全部需要 LLM。

---

# 14. 创作

这个毫无疑问。

LLM：

负责：

```
Intent

↓

Text
```

---

# 但是关键来了：

## LLM 不应该生成什么？

很多 AI 小说失败就是这里。

---

错误：

```
LLM:

直接生成 Chapter
```

因为：

没有中间层。

---

正确：

```
Planner LLM

↓

Novel IR

↓

Validator

↓

Writer LLM

↓

Text
```

---

# 那么完整架构应该是什么？

我觉得类似：

```
                  User
                   |
                   v

             Creative Agent
              (LLM)

                   |
                   v

          Narrative IR
        =================
        World State
        Characters
        Events
        Threads
        Goals
        Constraints
        =================

                   |
        +----------+-----------+

        |                      |

 Rule Engine             LLM Critic

        |                      |

        +----------+-----------+

                   |

             Renderer LLM

                   |

              Novel Text
```

---

# 进一步：LLM 也应该分等级

不要一个 GPT-5 干所有事情。

类似软件：

```
Compiler
    |
Frontend
Backend
Optimizer
```

小说：

```
Novel Compiler

    |
    |
    +-- Planner Agent
    |
    +-- Character Agent
    |
    +-- Continuity Agent
    |
    +-- Style Agent
    |
    +-- Writer Agent
    |
    +-- Reviewer Agent
```

---

# 成本问题

这是关键。

如果一部长篇：

100万字。

传统 AI 写法：

每章：

20k token

100章：

200万 token

还不算修改。

爆炸。

---

你的 Harness 应该：

## 1. 永久状态不用 LLM

例如：

角色：

```
Alice profile
```

存数据库。

不要每次总结。

---

## 2. Incremental Update

类似 Git。

修改：

Chapter 20

只影响：

```
Character Alice

Thread Revenge

Timeline
```

不用全书重新分析。

---

## 3. 分层模型

例如：

小模型：

- Entity Extract
- Summary
- Classification

大模型：

- Creative
- Rewrite

比例：

可能：

90% 小模型

10% 大模型。

---

# 最终系统边界

我认为：

## 可以做到：

### 高可靠

★★★★★

- 世界观管理
- 人物关系
- 时间线
- 伏笔
- 多线剧情状态
- 版本管理


---

### 中可靠

★★★☆

- 剧情规划
- 人物成长
- 节奏分析
- 风格保持


---

### 不可保证

★★

- 伟大的创意
- 文学突破
- 深层主题
- 独特审美


---

# 一个非常重要的判断

如果你的目标是：

> AI 自动写完一本小说

失败概率很高。

因为：

文学创造不是工程问题。

但是如果目标：

> 创建一个让 AI 可以像程序员一样长期维护一个小说世界的操作系统

这个非常有机会。

因为现在缺的不是：

"会写一句话的 AI"

而是：

> **一个可以让 AI 在百万字尺度保持一致、可修改、可验证、可协作的运行环境。**

你的 Novel Harness 的核心价值其实不是替代作者。

而是：

**给 LLM 提供一个类似“操作系统”的世界。**

### User
但是问题来了，直接用数据库存也有问题，比如 第二章 alice 下线了，我想回头改第一章，是不是出发 alice 死了

### Assistant
你这个问题其实直接击中了 **Novel IR 设计里最难的问题之一：时间一致性（Temporal Consistency）和版本分叉（Branching Timeline）**。

你发现了一个关键矛盾：

> 如果数据库保存的是“当前世界状态”，那么修改过去会污染未来。

这和普通业务数据库不一样。

普通数据库：

```
订单状态：
created -> paid -> shipped
```

过去基本不可变。

但是小说：

```
Chapter 1
    ↓
Chapter 2
    ↓
Chapter 3
```

作者可能突然：

> 我觉得 Alice 不应该在第二章死亡，而应该是假死。

那么：

```
过去改变
↓
未来全部重新解释
```

所以简单数据库模型会崩。

---

# 这其实和软件工程里的几个问题高度类似

## 1. Git

小说不是 CRUD 数据库。

更像 Git。

为什么？

因为：

修改历史是正常操作。

例如：

```
Chapter 1 v1

        |
        |
      Chapter 2

        |
        |
      Chapter 3
```

你修改：

```
Chapter 1 v2
```

不是：

覆盖。

而是：

产生新的世界分支。

类似：

```
main

 |
 |
Chapter3


experiment/alice-survive

 |
 |
Chapter1-v2
```

---

所以：

第一原则：

> 小说状态必须是版本化状态，而不是单一状态。

---

# 第二个问题：不要存 State，存 Event

这是更关键的。

刚才我说：

```
Alice.alive=false
```

其实还不够好。

因为：

状态是结果。

真正应该存：

## Event Sourcing

软件架构里有一个模式：

Event Sourcing。

不要存：

```
余额 = 100
```

存：

```
存入100
取出50
存入50
```

状态是计算出来的。

---

小说：

不要：

```
Alice:

alive=false
```

而是：

```
Event Stream
```

例如：

```
Event 001

Alice born


Event 002

Alice joins kingdom


Event 003

Alice injured


Event 004

Alice fake death


Event 005

Alice returns
```

状态：

由事件重放：

```
Replay Events

↓

Current World State
```

---

于是：

你修改第一章：

原来：

```
Event:

Alice poisoned
```

改成：

```
Event:

Alice escaped
```

重新 replay：

得到新的世界。

---

这就解决了：

> 修改过去影响未来

因为未来不是存储的。

未来是计算出来的。

---

# 但是又出现第三个问题：

## 小说不是完全线性的

例如：

作者有两个版本：

版本 A：

```
Alice dies
```

版本 B：

```
Alice survives
```

怎么办？

答案：

Branch。

---

类似：

Git：

```
                 Chapter 2
                    |
        +-----------+------------+
        |                        |
     Alice dead             Alice alive
        |                        |
    Chapter3A               Chapter3B
```

---

所以 Novel IR 应该天然支持：

```
Timeline Branch
```

---

# 第四个问题：

但是 Event 也不够。

为什么？

因为文学里面有：

"后来揭示"

例如：

第一章：

```
Alice looks at the ring.
```

作者没有说：

她知道戒指秘密。


第十章：

```
Reveal:

Alice was the owner.
```

如果你的数据库：

第一章：

```
Alice knows ring=true
```

就错了。

---

所以需要：

## Epistemic State（认知状态）

这是叙事学非常重要的概念。

世界状态：

```
World Truth
```

和：

角色知道的：

```
Character Knowledge
```

必须分离。


例如：

真实：

```
Ring belongs Alice
```

但是：

Bob:

```
unknown
```

Alice:

```
known
```

Reader:

```
unknown
```

---

所以：

你的 IR 至少有：

```
World State

Character Belief State

Reader Knowledge State
```

---

# 第五个问题：修改第一章是否应该自动触发第二章重写？

这里又像软件。

不是所有修改都重新编译。

需要：

Dependency Graph。

---

例如：

修改：

```
Alice hair color
```

影响：

```
Description scenes
```

但是：

不会影响：

```
Plot
```

---

修改：

```
Alice alive status
```

影响：

```
Chapter 2
Chapter 3
Chapter 4
```

---

所以需要：

```
Dependency Graph
```

类似：

Webpack:

```
module A

depends

module B
```

---

小说：

```
Event:

Alice death

depends:

Chapter 1 decision
```

---

然后：

修改：

```
Chapter1
```

系统：

计算：

affected nodes

```
Chapter2
Chapter3
Character Arc
```

只重新检查这些。

---

# 第六个问题：LLM 在这里干什么？

这里其实特别适合 LLM。

因为：

程序知道：

```
Alice death event changed
```

但是不知道：

影响：

```
哪些情节
```

所以：

Hybrid：

---

传统：

发现：

```
Event changed
```

↓

找到：

```
direct dependencies
```

---

LLM：

分析：

```
semantic dependencies
```

例如：

Alice 死亡影响：

- 她妹妹心理变化
- 反派计划
- 最终战争

---

输出：

```
Possible Impact:

Character:
Sister

Thread:
Revenge

Confidence:
0.85
```

然后人工确认。

---

# 所以一个更合理的 Novel IR 应该不是：

```
Database

Characters
Events
Scenes
```

而应该：

```
Novel Repository


Timeline DAG

    |
    |
Event Stream

    |
    |
World State Projection


Character Belief Graph


Narrative Dependency Graph


Draft Text
```

---

类似：

```
Git
 +
Database
 +
Event Sourcing
 +
Knowledge Graph
 +
Compiler
```

---

# 最终回答你的问题

> 第二章 Alice 下线了，我回头改第一章，会不会触发 Alice 死了？

如果设计错误：

会。

例如：

```
characters table

Alice.alive=false
```

这是一个坏设计。


正确设计：

应该：

```
Chapter 1 Revision

↓

Event Stream Changed

↓

Rebuild World Projection

↓

Run Impact Analysis

↓

Update affected scenes
```

也就是说：

**数据库不是存“小说是什么”，而是存“小说发生过什么”。**

最终小说状态只是一个可重新计算的 View。

---

其实你现在碰到的问题，已经从“AI 写小说”进入了一个更深的方向：

> 如何设计一个可以被修改、回滚、分支、验证的叙事计算系统。

这个问题非常接近：
- Git 的版本模型
- 数据库 Event Sourcing
- 编译器增量编译
- 游戏引擎状态管理

这也是为什么我认为这个方向有研究价值：真正困难的地方不是生成文字，而是**让一个 AI 能长期维护一个不断变化的虚拟世界。**

### User
我现在详细说明我想要的成品吧
就是一个软件工程辅助小说创作的软件
我希望用户的最终效果是：和一个熟悉的 ai interface （比如opencode）交互，把小说的灵感，大致剧情，如果是同人小说还要世界观和原文参考等等，和这个 interface 敲定
然后 interface 将这些变成可以工程化的东西，进入工程的流程进行小说的生产
注意，在此期间所有的步骤都是可调试可插入的。然后对 llm 依赖的部分原则上也可以用人工介入：比如人工介入编写步骤，拿着 context 的剧情，人设等等写一段插进去，或者直接改剧情等等
还有反馈步骤：用户可以拿着自己的 ai interface 交互说该改什么，什么风格不好，什么地方出戏，拿回来改
整体的项目也应该有可拓展性，可以随着用户的需求，让 ai interface 拓展结构

目前暂定成品为商业小说，流程可以参考商业小说的成熟流程，但是尽量在不同小说中通用，可拓展且不会破坏架构

然后这里需要有一些假设：llm 输入应该和“人类输入”一个等级，作为外部不可靠输入，需要进行校验等等
还有就是我需要保证一点就是它能兼容小说常见的技法和修辞
第一人称，第三人称，明暗线不混乱等等

还有各种常见的视角混乱，拿到不该拿到的信息等等

你最好去网上找找这方面的前沿研究

### Assistant
我认真看完你的设想之后，我觉得有一个很重要的判断。

**你想做的不是 AI 小说软件。**

也不是 Story Bible。

更不是 SillyTavern。

我觉得它更接近：

> **Story Engineering Platform（故事工程平台）**

或者叫

> **Narrative OS（叙事操作系统）**

这个定位非常重要，因为它决定了整个架构。

---

## 我去看了一圈目前前沿研究

有意思的是，**整个研究方向已经开始向你想的方向走了。**

但是，他们基本都只走到一半。

例如 2025、2026 的 Narrative Planning 论文，已经明确提出：

> **LLM 不应该直接写故事，而应该参与 Narrative Planning（叙事规划）。**

另外一篇 AIIDE 的论文提出：

> 用 PDDL（自动规划语言）描述故事，再由 LLM 渲染文本。

这是一个非常重要的信号。

因为他们已经开始：

```
Natural Language

↓

Formal Narrative Domain

↓

Planner

↓

Story

↓

LLM
```

而不是：

```
Prompt

↓

Story
```

---

更巧的是，今年 Google DeepMind 等人做的 **Fabula**（2026）几乎已经提出了你的一个核心思想：

> **用户应该能看到 Story Plan，而不仅仅是最终文本。**

他们甚至研究了：

- Scene
- Beat
- Story Plan

这些是不是应该暴露给作者。

但是：

Fabula 没有软件工程。

它还是：

```
Writer

↓

Plan

↓

Writer
```

而不是：

```
Project
```

---

## 我觉得你的创新点其实不是 Planner

而是：

> **Software Engineering over Narrative**

我甚至觉得可以画成：

```
Git

↓

Code Review

↓

CI

↓

Testing

↓

Compiler

↓

Artifact
```

对应：

```
Novel Repo

↓

Narrative Review

↓

Continuity CI

↓

Narrative Test

↓

Narrative Compiler

↓

Novel
```

这已经不是 Prompt Engineering。

而是：

Story Engineering。

---

# 我现在最大的建议（也是我觉得最关键的一点）

你不要设计：

```
Story Database
```

而应该设计：

## Narrative Repository

为什么？

Git 管理的不是：

```
代码运行结果
```

Git 管理的是：

```
开发过程
```

小说也一样。

Repository 应该保存：

```
Idea

↓

Decision

↓

Outline

↓

Scene Plan

↓

Draft

↓

Review

↓

Revision

↓

Release
```

而不是：

```
Character Table
```

---

# 我觉得整个系统应该分四层

这也是我目前想到最稳定的一种架构。

---

## 第一层：Artifact（工程产物）

这里全部都是文件。

例如：

```
novel/

spec/

outline/

characters/

world/

threads/

chapters/

drafts/

reviews/

tests/
```

所有东西：

Versioned。

Diff。

Merge。

Branch。

---

## 第二层：Engine（传统程序）

这一层：

**绝不依赖 LLM。**

例如：

```
Dependency Graph

Timeline

Entity Graph

Knowledge Graph

Version Graph

Pipeline

Workflow

Rule Engine

Parser

Compiler
```

全部：

Deterministic。

---

## 第三层：LLM Adapter

LLM：

永远：

不是 Engine。

只是：

```
External Tool
```

例如：

```
Scene Planner

Character Designer

Dialogue Writer

Editor

Reviewer

Critic
```

所有输出：

Schema。

JSON。

Proposal。

不是：

直接修改工程。

---

## 第四层：Human Interface

例如：

Opencode。

Cursor。

Claude Code。

用户：

永远：

操作：

Project。

不是：

Prompt。

例如：

```
> 我觉得 Alice 死太早了
```

系统：

不是：

```
改 Chapter2
```

而是：

生成：

```
Proposal

Change:

Alice Death

↓

Fake Death
```

然后：

Impact Analysis。

---

## 这里我突然想到一个非常重要的思想

其实：

LLM 不应该操作：

Project。

而应该操作：

## Patch。

是不是很像 Git？

例如：

LLM：

输出：

```
Patch

Modify:

Scene 4

Reason:

Character Arc
```

系统：

Validator：

```
Pass
```

Merge。

否则：

Reject。

---

这意味着：

LLM：

永远：

不能：

```
set(character.alive=false)
```

只能：

```
Proposal:

kill Alice
```

---

# 然后就是你问的：

> 如何兼容小说所有技法？

这里我觉得：

千万不要：

把：

```
第一人称

第三人称

倒叙

多 POV

伏笔
```

做成：

数据库字段。

一定会爆炸。

---

应该：

做成：

Plugin。

例如：

```
Narrative Capability
```

例如：

```
POV Plugin

Flashback Plugin

Foreshadow Plugin

Detective Plugin

Romance Plugin

Time Loop Plugin
```

为什么？

因为：

新的小说技法：

以后：

一定会继续出现。

你的 Core：

不能知道：

什么叫：

时间循环。

---

例如：

Time Loop Plugin：

提供：

```
Loop State

Loop Counter

Memory Retention
```

Engine：

不知道。

Plugin：

知道。

---

例如：

第一人称：

Plugin：

规定：

```
Narrator Knowledge

==

POV Knowledge
```

Validator：

检查：

有没有：

超视角。

---

例如：

第三人称全知：

Plugin：

关闭：

这个 Rule。

---

是不是：

整个 Core：

不用改。

---

# 我觉得最大的突破口其实不是 Novel IR

而是：

## Narrative Capability System

类似：

VSCode。

Core：

非常小。

例如：

```
Entity

Event

Scene

Thread

Dependency

Artifact
```

然后：

插件：

注册：

```
Flashback

register()

↓

新增：

Timeline Validator
```

---

插件：

注册：

```
Mystery Novel
```

新增：

```
Secret Knowledge

Reveal Order

Evidence Graph
```

---

这时候：

商业小说。

轻小说。

无限流。

克苏鲁。

悬疑。

全部：

都是：

Capability。

不是：

Hardcode。

---

## 最后，我觉得你的系统应该有一条最重要的设计原则

这一条我甚至建议写进架构设计文档首页：

> **LLM 与人类作者具有完全相同的系统权限。**

也就是说：

- 人和 LLM 都只是"贡献者（Contributor）"。
- 两者都不能直接修改 Project State。
- 两者都只能提交 **Proposal（提案）/ Patch（补丁）**。
- 所有修改都必须经过同样的 Schema 校验、Rule Engine、依赖分析、影响分析和版本控制。
- 整个 Repository 永远是真正的"事实来源（Source of Truth）"。

这是软件工程几十年验证过的思想：**不要相信任何输入。**

对于你的系统，我甚至会进一步抽象成一句话：

> **Treat every creative action as an untrusted patch.**

不管这个 Patch 来自 GPT-5、Claude、Qwen，还是来自诺贝尔文学奖得主，进入工程系统之后都只是一个待验证的补丁。

---

我还有一个更大胆的建议，也是我觉得这个项目真正有可能成为"研究"而不仅是"产品"的地方。

我建议不要把它定位为 **AI Novel Framework**。

而是尝试定义一种新的规范，例如：

> **Narrative Engineering Specification (NES)**

它类似于 OpenAPI、LLVM IR 或 Kubernetes CRD，不绑定任何模型，也不绑定任何 UI，而是一套描述"故事工程"的开放规范。

如果真的做到这一步，那么 Opencode、Claude Code、SillyTavern、VS Code 插件，甚至未来其他 AI，都可以作为同一个 Narrative Repository 的前端。真正长期存在的不是某个模型，而是这套**可验证、可扩展、可协作的叙事工程标准**。我认为，这比单纯做一个 AI 写作工具的价值要大得多。

### User
找到那几篇论文的项目地址，然后分析项目

### Assistant
我看完这些论文和能找到的项目之后，反而更加确定了一件事：

> **目前学术界解决的是"如何让 LLM 更好地规划故事"，而你想解决的是"如何让故事像软件一样被开发"。**

这是两个不同的问题。

下面我按"论文 → 有没有项目 → 值不值得研究 → 对你的启发"来分析。

---

# 1. Fabula（2026）

论文：

**Fabula: Building a Narrative Storytelling Sidekick with the Writers' Community**

## 项目

**没有开源。**

目前只有论文。

没有 GitHub。

---

## 它真正做了什么？

论文里面最有价值的不是 LLM。

而是 UI。

它整个流程：

```text
Idea

↓

Story Plan

↓

Scenes

↓

Beats

↓

Script

↓

Novel
```

注意：

它不是：

```text
Prompt

↓

Novel
```

而是：

**用户始终可以编辑 Story Plan。**

这是最大的进步。

---

## 它的问题

但是它没有：

- Version
- Git
- CI
- Dependency
- Rule Engine

Story Plan 仍然只是：

LLM Context。

不是：

工程。

---

## 对你的价值

我认为：

Fabula 可以借鉴：

UI。

不要借鉴：

Backend。

因为 Backend 基本还是：

LLM 驱动。

---

# 2. There and Back Again（AIIDE 2023）

论文：

There and Back Again: Extracting Formal Domains for Controllable Neurosymbolic Story Authoring

---

## 有没有项目？

论文没有公开完整系统。

但是：

他们使用：

Glaive

PDDL

GPT

进行实验。

不是产品。

---

## 它最核心思想

他们提出：

```
Natural Story

↓

PDDL

↓

Planner

↓

Plan

↓

LLM

↓

Story
```

是不是很熟？

因为：

他们已经开始：

把小说：

变成：

Planning Domain。

---

## 为什么我觉得这个论文很重要？

因为：

这是目前最接近：

Novel IR

的论文。

但是：

PDDL 太弱。

例如：

PDDL：

```
Move

Attack

Pickup
```

很好。

但是：

小说：

```
Alice 内心开始怀疑 Bob。
```

怎么写？

PDDL 很痛苦。

所以：

他们只能：

Action。

不能：

Narrative。

---

## 启发

不要直接用：

PDDL。

但是：

学习：

Planning。

---

# 3. Narrative Planning Model Acquisition

论文：

Narrative Planning Model Acquisition from Text Summaries and Descriptions

---

他们解决：

另一个问题。

不是：

生成小说。

而是：

```
小说简介

↓

Planning Domain
```

自动生成。

---

这其实就是：

```
Natural Language

↓

Novel IR
```

最早版本。

---

但是：

Domain：

仍然：

PDDL。

---

# 4. Belief Planning

论文：

Using Domain Compilation to Add Belief to Narrative Planners

这个我非常推荐你读。

原因：

它第一次提出：

> Character Belief

不是：

World State。

---

例如：

真实：

```
Bob

dead
```

Alice：

```
认为：

Bob alive
```

Bob：

```
不知道 Alice 在骗他
```

Reader：

```
知道 Bob 死了。
```

这其实：

就是：

三个世界。

---

是不是：

你昨天问：

POV？

第一人称？

超视角？

全部解决。

---

我觉得：

未来：

Novel IR

至少：

必须：

```
World Truth

Character Beliefs

Reader Beliefs
```

三个 Layer。

---

# 5. Fog of War Planning（2025）

论文：

Speeding Up Narrative Planning Using Fog of War Pruning

这个论文：

让我很惊讶。

他们发现：

如果：

Planner：

知道：

```
主角不知道

↓

不要搜索
```

速度：

快很多。

---

例如：

Alice：

不知道：

地下室。

Planner：

不会：

搜索：

地下室剧情。

---

是不是：

突然：

第一人称：

天然支持。

---

这个：

其实：

就是：

Knowledge Boundary。

---

我觉得：

Novel Harness

也应该：

有：

Knowledge Scope。

---

# 6. NL2PDDL

GitHub：

urlIBM/NL2PDDL

---

这个项目：

值得：

看。

原因：

不是：

Planning。

而是：

Pipeline。

例如：

他们：

不是：

Prompt。

而是：

```
NL

↓

Extract

↓

Schema

↓

Validate

↓

Planner
```

是不是：

Compiler。

---

# 7. LLM+P

代码：

论文对应 GitHub 在论文中公开。

---

他们：

已经证明：

一个事情：

```
LLM

+

Planner

>

LLM
```

---

这个：

其实：

就是：

Harness

思想。

---

# 但是，我真正有兴趣的是 Reddit 上一个项目

这个：

不是论文。

但是：

特别像：

你。

有人：

自己：

做：

小说：

Pipeline：

```
World Generator

↓

Character Architect

↓

Story Synopsis

↓

Chapter Planner

↓

Scene Planner

↓

Scene Writer

↓

Critic

↓

Rewrite

↓

Continuity Memory
```



---

是不是：

已经：

开始：

Workflow。

但是：

它：

还是：

Pipeline。

不是：

Project。

---

# 我认为这些项目共同的问题

我总结了一下。

他们全部都是：

```
Text

↓

Text

↓

Text

↓

Text
```

即使：

有：

Planner。

Planner：

也是：

文本。

例如：

```
Chapter Plan.md
```

不是：

Engine。

---

所以：

没有：

Diff。

没有：

Dependency。

没有：

AST。

没有：

IR。

---

# 我反而想到一个更大的方向

我觉得：

你不要：

参考：

AI 小说。

你应该：

参考：

编译器。

例如：

现在：

所有论文：

都是：

```
Natural Language

↓

LLM

↓

Planner

↓

LLM
```

但是：

真正的软件：

不是：

```
Text

↓

Compiler
```

而是：

```
Text

↓

Lexer

↓

Parser

↓

AST

↓

IR

↓

Optimizer

↓

Machine Code
```

---

所以：

如果：

让我：

重新设计：

Novel Harness。

我现在：

已经不会：

做：

Story Bible。

我会：

先做：

```
Narrative AST
```

然后：

```
Narrative IR
```

然后：

所有：

LLM：

全部：

围绕：

IR。

不是：

Prompt。

---

## 我觉得接下来最值得研究的东西已经不是论文，而是另一批系统

看到这里，我反而改变了建议。

你真正应该研究的，已经不是 AI 小说论文了，而是另外几类**成熟的软件系统**：

- **LLVM**：为什么所有语言最后都会汇聚到一种 IR？
- **Bazel / Buck2**：它们如何做增量构建、依赖分析和只重编译受影响的模块？
- **Git**：为什么 Commit、Branch、Merge 可以支持无限修改历史？
- **Event Sourcing / CQRS**：为什么系统保存的是事件而不是最终状态？
- **Language Server Protocol (LSP)**：为什么编辑器、补全、Lint、跳转都能围绕同一个抽象工作？

因为我越来越觉得，你想做的东西，本质上不是一个 AI Agent。

它更像是：

> **LLVM + Git + Bazel + LSP，只不过处理对象从程序变成了叙事。**

而目前我看到的几乎所有论文，都还停留在"如何让 LLM 更会写故事"。**真正缺失的是一个"Narrative Compiler Infrastructure"（叙事编译基础设施）**——也就是一个稳定的中间表示、统一的规则系统和可插拔的分析框架。

说实话，这也是我目前认为你这个方向最有原创性的地方。它和现有工作并不是竞争关系，而更像是在为它们提供底层运行时。

### User
中间表示应该是自然语言么，如果不是的话，llm又应该如何理解

### Assistant
这是整个项目最核心的问题。

而且我觉得这里有一个**很多 AI Agent 都踩进去的大坑**：

> **"为了让程序理解，把一切结构化。"
>
> 最后发现 LLM 理解不了了。**

反过来：

> **"为了让 LLM 理解，全部自然语言。"
>
> 最后程序什么都做不了。**

所以，你其实是在找一个 **Programming Language ↔ Natural Language** 之间的中间地带。

---

# 我现在的观点已经不是"IR 应该是不是自然语言"

而是：

> **Novel IR 应该有三个层次。**

不是一个。

---

# 第一层：Machine IR（程序看的）

例如：

```yaml
scene:
  id: scene_12

events:
  - actor: alice
    action: enter
    target: castle

  - actor: alice
    action: observe
    target: bob

effects:
  bob:
    alive: false
```

程序特别喜欢。

因为：

- 可以 diff
- 可以 merge
- 可以 lint
- 可以 validate

---

但是。

LLM 其实很讨厌。

因为：

这不是语言。

它没有：

- 语义
- 氛围
- 推理空间

---

所以：

Machine IR：

不能直接喂 LLM。

---

# 第二层：Semantic IR（我觉得最重要）

例如：

```
Scene Goal

Alice discovers Bob has died.

Conflict

Alice does not want to believe it.

Narrative Function

Reveal.

Thread

Main Mystery.

POV

Alice.

Knowledge

Alice:
didn't know Bob was dead.

Reader:
also didn't know.

Ending State

Alice decides to investigate.
```

注意：

它仍然：

不是小说。

但是：

它已经：

像人写的大纲。

---

LLM：

特别喜欢。

因为：

全部都是：

自然语言。

但是：

高度结构化。

---

它其实：

更像：

Markdown。

例如：

```
# Scene

## Goal

...

## Conflict

...

## Result

...
```

是不是：

人：

也愿意写。

---

# 第三层：Rendered Text

真正：

小说。

例如：

> Alice 推开门。

> 房间安静得可怕。

......

---

所以：

整个流程：

应该：

```
Machine IR

↓

Semantic IR

↓

Novel
```

而不是：

```
Machine IR

↓

Novel
```

---

# 为什么我越来越觉得 Semantic IR 必须是自然语言？

因为：

LLM：

不是：

Compiler。

LLM：

其实：

更像：

一个人。

例如：

给人：

```
HP=20

Status=Fear
```

人：

不会写小说。

但是：

给：

```
Alice is exhausted.

She fears losing Bob.

She has only one chance left.
```

马上：

就能写。

---

所以：

Semantic IR：

应该：

就是：

**受约束的自然语言（Constrained Natural Language）。**

---

# 其实软件工程已经有类似东西

例如：

OpenAPI。

不是：

JSON。

也不是：

代码。

而是：

YAML。

为什么？

因为：

```
程序

↓

Parse
```

同时：

```
人

↓

Read
```

---

Terraform。

Docker Compose。

GitHub Actions。

全部：

都是：

DSL。

不是：

JSON。

---

所以：

Novel IR：

其实：

也应该：

DSL。

---

例如：

```
Scene

Purpose

Reveal Bob's death.

POV

Alice

Conflict

Alice refuses to accept reality.

Ending

Alice decides to search the killer.

Thread

Mystery

Emotion

Shock -> Denial -> Determination
```

是不是：

程序：

很好 Parse。

LLM：

也很好理解。

---

# 我甚至觉得不应该设计 JSON

很多人第一反应：

设计：

```json
{
  "goal":"..."
}
```

其实：

不对。

因为：

LLM：

读 JSON：

非常费 token。

也：

不好修改。

---

Markdown：

反而：

最好。

例如：

```markdown
# Scene 12

## Goal

Reveal Bob's death.

## POV

Alice

## Knowledge

Alice doesn't know Bob is dead.

Reader doesn't know.

## Conflict

Alice refuses to believe.

## Outcome

Alice decides to investigate.
```

是不是：

AI：

喜欢。

人：

喜欢。

Git：

喜欢。

---

# 然后程序怎么办？

其实：

程序：

不要：

直接 Parse Markdown。

应该：

Parser。

例如：

```
Markdown

↓

Parser

↓

AST

↓

Program
```

是不是：

编译器。

---

# 我甚至觉得应该反过来

真正 Source of Truth：

不是：

Markdown。

而是：

AST。

例如：

```
Scene

GoalNode

ConflictNode

OutcomeNode

POVNode
```

然后：

可以：

Render：

Markdown。

也可以：

Render：

JSON。

也可以：

Render：

Prompt。

---

是不是：

React：

```
Virtual DOM

↓

HTML
```

---

# 所以 Novel IR 应该是什么？

我现在越来越倾向：

**它不是一种格式。**

而是一棵：

```
Narrative AST
```

例如：

```
Project

 ├── Story

 ├── Character

 ├── Thread

 ├── Scene

 │      ├── Goal
 │      ├── Conflict
 │      ├── Events
 │      ├── Outcome
 │      └── Emotion Arc

 ├── World

 └── Timeline
```

AST：

程序维护。

---

然后：

输出：

一种：

```
Narrative DSL
```

例如：

Markdown。

---

LLM：

永远：

读：

DSL。

不是：

AST。

---

# 我想到一个以前编译器的发展历史

实际上，你的问题在编译器历史上出现过一次。

LLVM 最开始：

有人问：

> 为什么 LLVM IR 不直接写成机器码？

后来：

有人又问：

> 为什么 LLVM IR 不直接写成 C？

最后：

LLVM：

选择：

一种：

> **介于机器码和 C 之间的语言。**

因为：

- 太底层，没人能调试。
- 太高级，优化不了。

---

我觉得：

Novel IR：

也一样。

不能：

太结构化。

也不能：

太文学。

应该：

停留在：

> **Narrative DSL**

---

# 最后我提出一个我今天刚形成的观点

我觉得整个系统其实不应该只有一个 IR。

而应该像现代编译器一样，有**多级 IR（Multi-Level IR）**。

例如：

```
Natural Conversation
        │
        ▼
Idea IR
（灵感、需求、讨论）

        ▼
Story IR
（主线、主题、人物、世界）

        ▼
Scene IR
（Scene Goal、POV、Conflict、Outcome）

        ▼
Event IR
（State Transition）

        ▼
World State
（数据库 Projection）

        ▼
Novel Text
```

LLM 实际上主要工作在 **Idea IR ↔ Story IR ↔ Scene IR** 这些偏自然语言的层次；传统软件主要工作在 **Event IR ↔ World State** 这些确定性的层次。

我认为这种分层比寻找一个"万能 IR"更现实，也更符合现代编译器（如 MLIR）的思想：**不同层次保留不同层次的信息，每一层都选择最适合它的表示方式，而不是试图让一种格式解决所有问题。**这可能才是一个真正可扩展的 Narrative Compiler 应该采用的架构。

### User
引入这个预期能解决什么问题，是否：过度抽象 或者 实现困难

### Assistant
我觉得现在应该**踩一脚刹车**。

因为你现在已经进入了一个很多系统架构都会遇到的问题：

> **是不是为了架构而架构了？**

这是个非常好的问题。

我不会直接回答"是"或者"不是"，而是用一个软件工程的方法：

> **每引入一个抽象，都必须回答：它消除了什么耦合？如果拿掉它，会发生什么？**

---

# 我们先把整个系统简化

假设没有 IR。

只有：

```text
User

↓

LLM

↓

Chapter.md

↓

LLM

↓

Chapter.md
```

这是 SillyTavern。

有什么问题？

### 第一

不能 Diff。

第二

不能 Merge。

第三

不能 Validation。

第四

不能自动修改。

第五

上下文越来越长。

所以：

**需要一个结构。**

这个结构是必须的。

---

# 第一层抽象：Project

例如

```
Project

Character

World

Outline

Chapter
```

这个有没有意义？

有。

因为：

以前：

```
Prompt
```

现在：

```
Project
```

这是软件工程。

所以：

这个抽象值得。

---

# 第二层抽象：Entity

例如：

```
Alice

Bob

Castle
```

是不是值得？

也是。

因为：

否则：

以后：

Prompt：

```
Alice...
Alice...
Alice...
Alice...
```

全部重复。

Entity：

就是：

Single Source of Truth。

---

# 第三层抽象：Scene

Scene：

有没有意义？

也有。

商业小说本来：

就是：

Scene。

编辑也是这么工作的。

所以：

值得。

---

# 第四层：Event

这里开始危险了。

例如：

```
Alice

↓

Open Door

↓

Observe Bob
```

是不是一定需要？

其实：

**未必。**

为什么？

因为：

LLM：

天然理解：

Scene。

但是：

不一定理解：

Event。

很多：

Event：

其实：

只是：

为了程序。

---

例如：

```
推门

抬头

看见

愣住

后退
```

全部：

拆成：

Event。

有没有价值？

可能：

没有。

程序：

不会因为：

Door Open：

变聪明。

---

所以：

Event：

不要：

过细。

---

# 第五层：State Transition

例如：

```
Trust

↓

0.2

↓

0.5
```

这个：

是不是：

值得？

其实：

有点危险。

为什么？

因为：

小说：

不是 RPG。

很多：

情绪：

不能：

数字化。

例如：

```
Alice：

突然：

有点：

愧疚。
```

是多少？

不知道。

---

所以：

不要：

为了：

Machine。

强行：

结构化。

---

## 我现在反而觉得：

真正应该抽象的是：

Narrative Unit。

例如：

Scene：

```
Goal

Conflict

Outcome
```

而不是：

```
Emotion=0.72
```

---

# 为什么？

因为：

Goal

Conflict

Outcome

人：

也这么理解。

AI：

也这么理解。

程序：

也能理解。

这是：

三方交集。

---

# 我突然想到一个评价标准

我叫它：

> **三重可理解性（Triple Understandability）**

一个抽象：

必须：

同时：

满足：

```
Program

LLM

Human
```

例如：

Character。

Program：

理解。

LLM：

理解。

Human：

理解。

很好。

---

Scene。

也是。

---

Event。

Program：

理解。

Human：

勉强。

LLM：

还行。

一般。

---

Binary State：

```
Emotion=0.32
```

Program：

理解。

Human：

讨厌。

LLM：

也不喜欢。

失败。

---

所以：

以后：

每增加：

一个 Layer。

都问：

```
Human？

LLM？

Program？
```

---

# 那么 Multi-Level IR 值不值得？

其实：

不要：

因为：

LLVM。

就：

照抄。

LLVM：

为什么：

需要：

十几层？

因为：

CPU。

---

小说：

没有：

CPU。

---

所以：

我现在：

反而：

建议：

不要：

六层。

---

最多：

三层。

```
Idea

↓

Scene

↓

Text
```

结束。

---

其中：

Idea：

Project。

Scene：

Planning。

Text：

Render。

---

# 那 AST 呢？

AST：

也要：

小心。

很多人：

一想到：

Compiler。

就：

AST。

但是：

小说：

没有：

Grammar。

例如：

```
Alice

哭了
```

是不是：

Action？

Emotion？

Description？

没有：

唯一答案。

所以：

AST：

不要：

语法 AST。

---

而应该：

Semantic AST。

例如：

```
Scene

 ├── Purpose

 ├── POV

 ├── Thread

 ├── Constraints

 └── Expected Changes
```

是不是：

更稳定。

---

# 那么 Plugin 呢？

Plugin：

我反而：

觉得：

一定要有。

为什么？

因为：

它：

解决：

真正：

会变化的部分。

例如：

无限流。

推理。

克苏鲁。

Galgame。

Visual Novel。

全部：

新增：

Rule。

---

Core：

不要：

知道：

什么：

叫：

无限循环。

---

所以：

Plugin：

不是：

为了：

架构。

而是：

为了：

开放封闭原则。

---

# 那么最危险的地方是什么？

我觉得：

不是：

IR。

而是：

你容易：

掉进：

Ontology。

什么意思？

例如：

开始：

讨论：

```
Event

Action

Intent

Conflict

State

Belief

Arc

Thread

Beat

Plot

Narrative Function
```

越来越多。

最后：

写：

一本：

论文。

软件：

还没：

开始。

---

所以：

我建议：

采用：

Rust：

LLVM：

React：

共同：

遵守：

一个原则。

---

## Rule：

> Don't introduce abstraction until duplicated twice.

例如：

如果：

只有：

Scene。

就：

不要：

Beat。

如果：

Beat：

出现：

二十次。

再：

抽象。

---

例如：

第一版：

```
Scene

Goal

Conflict

Outcome

POV
```

够了。

以后：

发现：

商业小说：

全部：

都有：

Foreshadow。

再：

Plugin。

---

# 我的建议（也是我认为这个项目成败的关键）

我建议你把整个系统当成一个真正的软件产品，而不是一篇理论论文。

软件工程里有一句非常重要的话：

> **Architecture should emerge from pressure, not imagination.（架构应该来自真实压力，而不是想象。）**

也就是说，每增加一个概念，都要有一个**真实失败案例**支撑它。

例如：

- 为什么需要 `Thread`？因为没有它，伏笔和支线无法追踪。
- 为什么需要 `POV`？因为出现了视角泄露 Bug。
- 为什么需要 `Knowledge State`？因为角色知道了自己不可能知道的信息。
- 为什么需要 `Plugin`？因为时间循环小说开始污染整个 Core。

反过来，如果某个抽象只能回答"以后可能会有用"，那就不要放进 v1。

---

## 如果让我给你的项目设一个 MVP（最小可行架构）

我会限制 Core 只有 **7 个概念**：

```
Project
Character
World
Thread
Scene
Draft
Review
```

Scene 内部先只有：

```
Goal
POV
Constraints
Outcome
```

除此之外，一个都不要加。

然后让系统真正跑起来，写一部 20 万字小说。

只有当你遇到**真实的维护困难**时，再引入：

- Knowledge Graph
- Event IR
- Belief State
- Narrative AST
- Capability Plugin
- Narrative Compiler

这样，你最后得到的架构不是"看起来优雅"，而是**每一个抽象都经过真实项目验证**。

我认为，这也是 LLVM、Git、React、Kubernetes 这些成功系统真正走过的路。它们不是先设计出完整理论，而是在不断解决真实问题的过程中，让抽象自然沉淀下来。对于你的 Narrative Harness，我会坚持同样的原则。

### User
另一个问题：如果是人物成长小说，随着章节会成长，那么每个章节同一个人物应该不一样

或者过去和未来的事件，我写到第十章突然想更改第一章的某段内容，那我就需要找到那个时间段的 state

这个怎么做状态管理

### Assistant
我觉得这是目前为止你提出的**最关键的架构问题**。

而且我认为，这个问题实际上说明了一个更深的事实：

> **小说根本不是 CRUD 系统，而是 Temporal System（时间系统）。**

很多 AI 小说工具最大的错误，就是认为：

```text
Character
---------
name
age
personality
alive
```

这是角色。

其实不是。

对于小说来说，这张表几乎是错的。

---

# 为什么？

例如：

Alice

第一章：

```text
胆小
不相信别人
```

第十章：

```text
勇敢
开始相信别人
```

第三十章：

```text
成为领袖
```

那么：

真正的：

```text
Alice.personality
```

到底是什么？

没有答案。

因为：

**人格是时间函数。**

不是属性。

---

# 我现在越来越觉得

人物应该不是：

```text
Character
```

而是：

```text
Character Timeline
```

例如：

```text
Alice

Chapter1

↓

Chapter2

↓

Chapter3

↓

Chapter10

↓

Chapter50
```

每一个节点：

都是：

```text
Character Snapshot
```

---

## 软件工程有没有类似东西？

有。

其实很多。

最像的是：

### Git

例如：

Git：

没有：

```text
main.c
```

它只有：

Commit。

然后：

```text
git checkout
```

得到：

那个版本。

---

小说也是。

不要：

```text
Alice.current
```

而应该：

```text
Alice@Chapter1

Alice@Chapter10

Alice@Chapter30
```

是不是：

Version。

---

# 第二个灵感来自 Event Sourcing

Event Sourcing：

不保存：

```text
余额=100
```

保存：

```text
+100

-20

+50
```

余额：

算出来。

---

小说：

同样。

不要：

保存：

```text
Alice

confidence=0.7
```

保存：

```text
Chapter3

Event

↓

Bob saved Alice
```

```text
Chapter6

Event

↓

Alice betrayed
```

```text
Chapter9

Event

↓

Alice forgives Bob
```

然后：

计算：

Alice。

---

但是。

这里有一个问题。

---

# 小说不像银行。

Event：

不足够。

例如：

这一句：

> Alice 成熟了。

是什么 Event？

不知道。

所以：

不能：

完全：

Event Source。

---

我后来想到：

应该：

混合。

---

# Character 应该长这样

```text
Character

↓

Identity
```

固定：

```text
name

birthday

gender

appearance
```

这些：

几乎：

不会变。

---

然后：

```text
Evolution
```

例如：

```text
Arc

↓

Milestone
```

例如：

```text
Chapter1

Identity Crisis
```

```text
Chapter10

Learns Trust
```

```text
Chapter20

Sacrifice
```

---

然后：

真正：

给 LLM：

的是：

Snapshot。

例如：

Chapter12。

系统：

自动：

计算：

```text
Identity

+

所有 Evolution

↓

Character Snapshot
```

LLM：

拿：

Snapshot。

---

是不是：

像：

Materialized View。

---

# 但是你又提出：

如果修改第一章怎么办？

这个：

其实：

就是：

Git。

---

例如：

```text
Chapter1

↓

Chapter2

↓

Chapter3
```

修改：

```text
Chapter1
```

系统：

不要：

直接：

更新。

而是：

```text
Recompute
```

例如：

```text
Character Timeline

↓

invalidate

↓

Chapter2

↓

Chapter3

↓

Chapter10
```

重新：

Projection。

---

这里：

特别像：

Incremental Compiler。

---

例如：

LLVM：

修改：

```cpp
foo()
```

不会：

重新：

整个项目。

而是：

Dependency。

---

小说：

也是。

例如：

修改：

```text
Alice

Trust
```

影响：

```text
Dialogue

↓

POV

↓

Scene

↓

Ending
```

但是：

不会：

影响：

```text
Castle
```

---

# 所以：

真正需要的不是 Database。

而是：

Temporal Database。

其实数据库领域真的有这个概念。

例如：

SQL Server、Oracle、PostgreSQL 都研究过 **Temporal Database（时态数据库）**。

里面有两个时间：

```text
Valid Time
```

故事里面：

什么时候。

例如：

```text
Chapter10
```

---

还有：

```text
Transaction Time
```

作者：

什么时候：

修改。

例如：

今天：

修改：

第一章。

---

小说：

其实：

两个时间：

都有。

例如：

```text
Story Time

Alice

15 years old
```

和：

```text
Author Time

2026-08-01

修改
```

是不是：

两个时间轴。

---

# 我甚至觉得应该引入：

## Narrative Time

不是：

Chapter。

例如：

```text
Day1

↓

Day2

↓

3 months later

↓

10 years later
```

角色：

绑定：

Narrative Time。

不是：

Chapter。

因为：

有：

倒叙。

插叙。

---

例如：

Chapter20：

实际上：

发生：

Chapter2。

---

所以：

Character Snapshot：

应该：

```text
Character

+

Narrative Time

+

Revision
```

得到。

---

# 我今天最大的改变

其实。

我昨天一直在说：

Database。

今天：

我觉得：

不准确。

真正：

应该：

叫：

## Narrative State Store

它：

不是：

数据库。

而是：

一个：

**可以回答任何时刻任何人物状态**的系统。

例如：

```text
Query

Alice

At:

Story Time

Day23

Revision

main

↓

Snapshot
```

或者：

```text
Bob

At:

Before Battle
```

↓

得到：

那个：

Bob。

---

然后：

LLM：

永远：

不要：

自己：

总结：

Bob。

而是：

请求：

State Store。

---

# 我想到一个更符合软件工程的模型：**State 不是存出来的，而是"可求值的（Evaluable）"**

把人物看成一个对象（Object）会越来越痛苦；把人物看成一个"函数"反而会简单很多。

例如：

```text
CharacterSnapshot =
Evaluate(
    CharacterIdentity,
    StoryTime,
    Branch,
    Revision
)
```

也就是说，Alice 并没有一个"当前状态"。

只有：

- **Identity**（几乎不变）
- **Evolution Log**（成长事件）
- **Narrative Events**（发生过什么）
- **Branch**（当前故事分支）
- **Revision**（作者修改历史）

当系统需要"第十章的 Alice"时，它去求值（Evaluate）；当需要"修改后的第一章世界线里的 Alice"时，它换一个 Revision 和 Branch 再求值。

---

## 这样还有一个意外的好处

这意味着你的整个系统可以支持很多以前几乎做不到的功能：

- "给我看 Alice 在第 17 章时的完整状态。"
- "比较 Alice 在第 5 章和第 30 章的人设差异。"
- "如果撤销第二章这个剧情，她后面会发生哪些变化？"
- "把这个角色成长曲线可视化。"

这些都不再需要 LLM 去"回忆"，而是系统直接计算。

---

我认为，这可能才是你整个 Narrative Harness 最值得坚持的原则之一：

> **不要问"当前人物是什么样"，而要问"在某个故事时间、某个版本、某个分支下，这个人物是什么样"。**

这和 Git 从来没有"当前文件"、只有"某个 Commit 下的文件"是同一种思想。也是我认为能够真正支撑长篇小说长期维护的状态管理模型。

### User
你说的好，但是怎么计算？

### Assistant
这个问题就是从"概念设计"进入"真正系统设计"的分界线。

前面说：

> State 不是存出来的，而是可求值的。

听起来很好，但是**到底怎么 Evaluate？**

这里必须落地。

我先给结论：

> 不要试图“计算人物状态”。应该计算的是**状态变化事件（State Mutation Events）**，然后通过事件重放 + 快照 + 增量更新得到任意时间点状态。

也就是：

**Event Sourcing + Temporal Database + Dependency Graph。**

---

# 1. 首先定义：什么是状态？

不要：

```json
{
 name:"Alice",
 brave:true,
 trust:0.8
}
```

因为这个是最终结果。

应该拆成：

## Identity（静态）

不会变化：

```yaml
Character:
 id: alice

 name: Alice

 birth:
  year:2000

 appearance:
  hair:black
```

---

## State Variables

### User
继续

### Assistant
继续。

上一条讲到：

> 状态不要直接存最终结果，而是存“状态变化来源”。

接下来具体设计 **如何计算 Character Snapshot**。

---

# 2. 定义状态变量（State Variables）

不是所有人物信息都一样。

需要分类。

---

## A. 硬状态（Hard State）

可以确定计算。

例如：

```yaml
Alice:
  alive: true
  location: Castle
  age: 20
  possessions:
    - Sword
```

这些：

规则明确。

---

事件：

```yaml
Event:
 type: Death

 actor: Alice

 time: Day50
```

执行：

```typescript
state.alive = false
```

没有歧义。

---

## B. 软状态（Soft State）

例如：

- 信任
- 恐惧
- 愤怒
- 价值观
- 性格倾向

不要：

```json
{
 trust:0.73
}
```

因为这个数字是假精确。

应该：

事件驱动。

例如：

```
Alice trusts Bob
```

不是：

```
trust += 0.1
```

---

例如：

事件：

```yaml
Event:

type:
 SAVE_LIFE

actor:
 Bob

target:
 Alice
```

影响：

```yaml
Relationship:

Alice -> Bob

trust:
 increased
```

但是：

具体多少？

交给：

Rule + LLM。

---

例如：

规则：

```python
if action == SAVE_LIFE:
    trust_change = positive
```

LLM：

判断：

```text
当时 Alice 是否知道 Bob 救了她？
```

如果不知道：

不用增加。

---

所以：

软状态：

不是数值。

而是：

**带证据的状态。**

---

# 3. Event 是什么？

关键。

Event 不能只是：

```yaml
Alice opens door
```

太弱。

应该：

```yaml
Event:

id:
 event_1029

story_time:
 Day30

participants:
 Alice
 Bob

preconditions:
 Alice.location == Room

action:
 Alice discovers Bob secret

effects:
 Alice.knows(Bob.secret)=true

narrative:
 Reveal
```

---

注意：

Event 有：

## 前置条件

类似数据库事务。

例如：

```yaml
precondition:

Bob.alive=true
```

否则：

不能发生。

---

## Effect

发生后改变什么。

例如：

```yaml
effect:

Alice.knowledge += secret
```

---

# 4. 那么 Snapshot 怎么生成？

例如：

我要：

> 第十章结束时 Alice 的状态。

系统：

输入：

```
Character = Alice

Time = Chapter10

Branch = main
```

---

## Step 1

找到所有相关 Event。

例如：

```
Chapter1

Birth

↓

Chapter3

Meet Bob

↓

Chapter5

Betrayed

↓

Chapter8

Saved

↓

Chapter10

Forgive
```

形成：

```text
Event Stream
```

---

## Step 2

从初始状态开始。

```yaml
Alice:

alive=true

trust:

Bob=0
```

---

## Step 3

Replay。

类似：

```python
for event in events:
    apply(event,state)
```

---

得到：

```yaml
Alice@Chapter10:

alive=true

location:
 Castle

knowledge:
 Bob secret

relationship:
 Bob:
   trust:
      high
```

---

# 5. 但是每次重放所有事件太慢

如果一本小说：

100万字。

事件：

几十万。

怎么办？

软件早解决了。

---

## Snapshot（快照）

类似：

Git。

例如：

每 10 章：

保存一次：

```yaml
Snapshot:

Chapter10

Alice:

trust Bob=high

knowledge:
 secret1

location:
 Castle
```

---

现在：

查询 Chapter11：

不用：

从第一章算。

从 Chapter10 snapshot 开始。

---

类似：

数据库：

checkpoint。

---

# 6. 修改第一章怎么办？

这是关键。

假设：

原：

Chapter1：

Alice救Bob。

导致：

Chapter5：

Alice信任Bob。

---

现在改：

Chapter1：

Alice没有救。

---

发生：

Event 修改：

```diff
- Alice save Bob
+ Alice ignore Bob
```

---

系统：

不能直接改：

Alice。

因为：

Alice 没有存储。

---

而是：

找到：

依赖。

---

# 7. Dependency Graph

每个 Event：

有影响范围。

例如：

```text
Event:

Alice saves Bob

          |
          |
          +----> Relationship
          |
          +----> Bob survival
          |
          +----> Later dialogue
```

---

形成：

Graph：

```
Event
 |
 + Character State
 |
 + Plot Thread
 |
 + Scene
 |
 + Draft
```

---

修改 Event：

触发：

```text
invalidate
```

---

类似：

Webpack：

修改：

module A

↓

重新 build 依赖模块。

---

# 8. 那么 LLM 在哪里？

这里非常关键。

不要让 LLM 算。

LLM 不负责：

```
Alice现在是否活着
```

程序算。

---

LLM 做：

## 1. Event Extraction

从文本：

```
Alice终于原谅了Bob。
```

生成：

```yaml
Event:

type:
 FORGIVE

actor:
 Alice

target:
 Bob
```

---

## 2. Impact Prediction

修改：

```yaml
Event removed
```

问 LLM：

```
这个事件可能影响哪些软状态？
```

得到：

```yaml
Possible:

Alice personality arc

confidence:
0.8
```

---

## 3. Ambiguous Resolution

例如：

```
Alice看着Bob，心情复杂。
```

程序不知道。

LLM：

提议：

```yaml
Possible effects:

trust change

emotion change
```

人工确认。

---

# 9. 一个更完整的模型

我觉得最后应该类似：

```
                 User
                  |
                  |
             LLM Interface
                  |
                  |
            Proposal Layer
                  |
                  v

        +----------------+
        | Event Store    |
        +----------------+

                  |
                  |
          Event Processor

                  |
        +---------+---------+

        |                   |

 Hard State            Soft State

(Database)          (Knowledge Graph)


                  |
                  |
             Snapshot Engine

                  |
                  |
          Character Snapshot
```

---

# 10. 但是还有一个大问题：循环依赖

例如：

Alice成长：

因为：

Bob影响。

Bob成长：

因为：

Alice影响。

怎么办？

---

这里不能简单：

线性 replay。

需要：

## Event Ordering

所有 Event 必须有：

```yaml
story_time
```

例如：

```
Day1 Alice meet Bob

Day2 Bob saves Alice

Day3 Alice trusts Bob
```

有序。

---

如果：

两个事件同一天：

需要：

```yaml
causal_order
```

例如：

```
A causes B
```

---

这其实就是：

Causal Graph。

---

# 11. 所以最终状态计算公式类似：

不是：

```
Alice = Database Row
```

而是：

```
Alice Snapshot

=

Initial Character

+

Replay(
    Events
    ordered by
    Story Time
    and
    Causal Dependency
)

+

Rules

+

Approved LLM Inferences

```

---

# 但是我要指出一个非常现实的问题

这个系统**不要一开始做完整模拟器**。

因为完整模拟：

人物心理、价值观、情绪：

非常难。

更实际的 MVP：

第一阶段：

只做：

```
Hard State

+
Knowledge State

+
Relationship State
```

例如：

- Alice 活没活
- Alice 在哪里
- Alice 知不知道秘密
- Alice 和 Bob 什么关系

这已经可以解决：

80%的长篇一致性问题。

---

第二阶段：

加入：

```
Character Arc
```

例如：

- 从懦弱到勇敢
- 从仇恨到理解

但是不要数值化。

使用：

Milestone：

```
Fearful
 ↓
Questioning
 ↓
Accepting
 ↓
Courageous
```

---

第三阶段：

才考虑：

心理模型。

---

所以如果让我设计 v1：

我不会做"AI模拟人物人生"。

我会做：

> **一个可以回答“在任意故事时间点，任意版本下，这个角色知道什么、拥有什么、和谁是什么关系”的时态叙事数据库。**

这个目标是完全工程可实现的，而且已经足够成为一个有价值的 Novel Harness 核心。你后面想做的 POV、防止角色知道不该知道的信息、修改第一章影响后续、多人协作版本管理，全部都建立在这个基础之上。

### User
1 这样预期给模型的原始输出长什么样子
2 这套系统中，给模型写作的最小单元是什么，他会拿到什么信息去写

### Assistant
这两个问题其实决定了整个系统是否能落地。

因为前面讲的是 **State Store / Event / Snapshot**，但最终一定要回到：

> **LLM 到底吃什么 Context？**
>
> **LLM 到底一次写多少？**

如果这个设计错了，最后还是会退化成：

```
把几十万字塞给 GPT
→ 希望它记住
```

所以我们分开讨论。

---

# 1. 给模型的原始输入（Context Package）应该长什么样？

首先明确：

**不要直接给模型数据库。**

例如不要：

```json
{
 "character_id": "alice",
 "trust": 0.7,
 "event":[...]
}
```

这对模型很差。

数据库是给程序看的。

LLM 需要的是：

> 一个经过编译的 Narrative Context。

类似编译器：

```
Source Code
    |
    v
Compiler IR
    |
    v
Machine Code
```

你的系统：

```
Project Database
    |
    v
Narrative Context Compiler
    |
    v
LLM Context
```

---

## 一个 Scene Writer 的输入应该类似：

假设写：

第三章 Scene 5

---

## System Context

```markdown
# Writing Task

You are writing a fantasy novel.

Genre:
Dark fantasy

Style:
Slow-burn, psychological.

Narrative rules:

- First person POV
- Only reveal information known by narrator
- Avoid omniscient descriptions
```

---

## Scene Specification

这是最核心。

```markdown
# Scene

ID:
chapter3_scene5


Narrative Purpose:

Reveal that Alice suspects Bob.


Scene Goal:

Alice begins doubting Bob's loyalty.


Conflict:

Alice wants truth,
but fears losing Bob.


Expected Outcome:

Alice does not confront Bob yet.


POV:

Alice


Time:

Day 17
```

---

## Character Context

注意：

不是完整人物表。

而是：

**当前 Scene 需要的人物状态。**

例如：

```markdown
# Alice

Current state:

Age:
21


Current location:
Royal Library


Current emotional state:

Conflicted.

She trusts Bob,
but recent events created doubt.


Important memories:

- Bob saved her during the fire.
- Bob lied about the artifact.


Current goals:

Find the truth.

```

---

## Relationship Context

```markdown
# Relationship

Alice -> Bob


Current relationship:

Trust:
Medium


History:

Day 5:
Bob saved Alice.

Day 12:
Bob hid information.


Unresolved tension:

Alice suspects Bob is hiding something.
```

---

## World Context

只给相关。

不是：

整个世界观。

例如：

```markdown
# World Facts


Royal Library:

A forbidden archive exists below the library.


Known by:

King
Bob


Unknown by:

Alice
```

---

## Knowledge Boundary

这个非常重要。

```markdown
# Information Rules


Alice knows:

- Bob owns the artifact.

Alice does not know:

- Bob is working for the enemy.


Reader knows:

- Bob has hidden motives.
```

---

## Previous Scene Summary

不是全文。

例如：

```markdown
# Previous Scene


Alice found Bob's letter.

She noticed a strange symbol.

She decided to investigate.
```

---

最后：

模型看到：

```text
Scene Package

=
Task
+
Scene Intent
+
Character Snapshot
+
World Facts
+
Knowledge Boundary
+
Previous Context
```

---

这就是你的：

**Context Compiler。**

---

# 2. 最小写作单元是什么？

这是更加关键的问题。

很多 AI 写小说失败，就是粒度错了。

---

## 错误：

一次：

写一章。

例如：

```
Write Chapter 3
```

问题：

一章：

可能：

5000字。

里面：

10个剧情变化。

模型：

容易：

- 人设漂移
- 视角混乱
- 忘伏笔

---

## 也不要太小：

例如：

一句一句。

因为：

模型：

没有宏观目标。

---

我认为：

最佳单位：

## Scene（场景）

但是：

Scene 需要拆：

## Beat（节拍）

---

这个来自现代剧作理论。

例如：

电影：

不是：

一句一句。

而是：

Scene。

Scene 内：

Beat。

---

例如：

Scene：

```
Alice confronts Bob
```

内部：

Beat:

```
1.
Alice enters room.

2.
She notices Bob hiding something.

3.
Bob lies.

4.
Alice realizes the lie.

5.
She leaves without exposing him.
```

---

所以：

三级：

```
Novel

 |
Chapter

 |
Scene

 |
Beat
```

---

LLM 最适合：

生成：

Scene。

但是：

控制：

Beat。

---

# 为什么不是 Beat 作为最小？

因为：

Beat 太小。

例如：

```text
Alice turns around.
```

没有文学意义。

---

所以：

推荐：

## Planning Unit

Beat

## Generation Unit

Scene

## Review Unit

Chapter

---

类似软件：

```
Function

{
 statements
}
```

你不会：

一次生成整个项目。

也不会：

一次生成一个字符。

---

# 3. Scene 生成流程应该是什么？

例如：

用户：

```
写第三章第五场
```

系统：

---

## Step 1

取：

Scene Spec

```yaml
scene_id:
3-5

goal:
Alice suspects Bob

pov:
Alice
```

---

## Step 2

生成 Draft

LLM：

输出：

小说文本。

---

## Step 3

进入 Validator

不是：

直接保存。

检查：

---

### Continuity Check

```
Alice says:
"I know Bob killed the king"

ERROR:

Alice does not know this.
```

---

### Character Check

```
Alice forgives Bob immediately.

WARNING:

Contradicts character arc.
```

---

### Style Check

```
POV violation.
```

---

## Step 4

Human / AI Review

产生：

Patch。

---

# 4. 那如果模型需要自由发挥怎么办？

这是关键。

很多人担心：

结构化之后：

小说死板。

其实：

应该分：

## Constraint

和：

## Creative Space

---

例如：

Scene:

固定：

```
Alice discovers Bob secret
```

但是：

不固定：

```
怎么发现？
在哪里？
用什么语言？
```

---

类似游戏：

游戏设计：

规定：

```
Boss必须死亡
```

但是：

玩家：

怎么打：

自由。

---

# 5. 这里还有一个重要设计：Context 不是固定的

应该像：

IDE。

例如：

VS Code：

打开文件。

只加载：

附近。

---

LLM：

也是：

Dynamic Context Retrieval。

---

例如：

正在写：

Alice 和 Bob 对话。

需要：

加载：

```
Alice

Bob

Relationship

Current Mystery

Last conversation
```

---

不需要：

```
100年前战争史
```

---

所以：

Context Compiler：

应该类似：

Language Server。

---

# 最后总结成一个架构：

```
                 User
                  |
                  |
             AI Interface
                  |
                  |
          Narrative Compiler
                  |
        +---------+---------+
        |
        |
   Scene Specification
        |
        |
 Context Retrieval
        |
        |
 +------+------+-------+
 |             |       |
Character   World   Knowledge
Snapshot    Facts   Boundary

        |
        v

       LLM

        |
        v

     Draft Scene

        |
        v

 Validators

        |
        v

   Accept / Reject / Patch
```

---

所以回答你的两个问题：

## 1. 给模型的原始输出长什么样？

不是数据库 JSON。

而是：

**经过编译的 Narrative Context Package（结构化自然语言 + 少量元数据）。**

类似：

```
Scene Brief
+
Character Snapshot
+
World Context
+
Knowledge Boundary
+
Style Rules
+
Previous Context
```

---

## 2. 最小写作单元是什么？

推荐：

- **生成单位：Scene**
- **规划单位：Beat**
- **审核单位：Chapter**

不要让 LLM 写整章。

不要让 LLM 写一句。

Scene 是目前文学创作和工程控制之间最好的平衡点。

---

另外我觉得这里已经出现了一个很有价值的研究方向：

**Context Compiler（上下文编译器）**

可能比 Narrative IR 本身还重要。

因为未来所有长文本 AI 系统都会遇到同一个问题：

> 如何从一个巨大的、不断变化的世界状态中，编译出某一次模型调用真正需要知道的信息。

这其实就是小说版的 **数据库查询优化器 + 编译器优化 + RAG**。你这个方向如果继续深入，核心竞争力可能就在这里。

### User
另一个问题，现在的ai喜欢用缓存，怎么保证节约成本

### Assistant
这个问题非常关键，因为它决定了这个系统能不能商业化。

如果按照前面的设计，最容易出现一个灾难：

> 每写一个 Scene，都重新把世界观、人物、历史、规则全部塞给 LLM。

例如：

```
System:
50k tokens

World:
30k tokens

Characters:
20k tokens

History:
50k tokens

Scene:
5k tokens

=
155k tokens / request
```

写一本 100 万字小说，成本会爆炸。

所以必须设计**叙事系统自己的缓存机制**。

这里我觉得可以借鉴：

- 编译器缓存
- 数据库缓存
- Git
- CDN
- LLM Prompt Cache

---

# 1. 首先明确：什么东西应该缓存？

不要缓存最终文本。

应该缓存：

**中间产物。**

类似软件：

不会每次：

```text
source code

↓

machine code
```

重新编译。

而是：

```
source
 ↓
object cache
```

---

小说：

应该：

```
Project State

↓

Narrative Context Compiler

↓

Context Package

↓

LLM
```

缓存：

Context Package。

---

# 2. Context Cache

例如：

第一次：

生成：

Chapter 3 Scene 5。

系统计算：

```yaml
Context Package:

Alice:
 snapshot v15

Bob:
 snapshot v9

World:
 version 3

Rules:
 version 2
```

Hash：

```
ctx_hash =
hash(
 alice_v15,
 bob_v9,
 world_v3,
 rules_v2
)
```

保存：

```
cache/

abc123.context
```

---

下一次：

继续修改 Scene。

检查：

```
ctx_hash
```

没有变化。

直接复用。

---

类似：

Webpack。

---

# 3. Character Snapshot Cache

这是最大的收益点。

例如：

写：

Chapter 20。

需要：

Alice。

如果每次：

重新计算：

```
Chapter1
Chapter2
...
Chapter20
```

浪费。

---

所以：

保存：

```
Alice Snapshot

Chapter10
Chapter20
Chapter30
```

---

查询：

Chapter23：

不用：

0 -> 23

而是：

20 -> 23

---

类似：

数据库 checkpoint。

---

# 4. Embedding Cache

另一个巨大成本。

很多系统：

每次：

重新 embedding。

错误。

---

应该：

每个 Artifact：

有：

content hash。

例如：

```
character/alice.md
```

hash:

```
a83bc9
```

embedding:

```
vector_a83bc9
```

---

修改：

hash 变：

重新 embedding。

否则：

复用。

---

# 5. LLM Prompt Cache

现在很多模型提供：

Prompt Cache。

例如：

OpenAI / Anthropic 都有类似机制。

思想：

如果：

前缀相同：

不用重复计算。

---

你的系统天然适合。

因为：

大量内容固定：

```
System Prompt

+
World Rules

+
Character Database
```

变化：

只有：

Scene。

例如：

请求：

第一次：

```
[100k fixed context]
+
Scene 1
```

第二次：

```
[100k fixed context]
+
Scene 2
```

那么：

前100k token：

可以 cache。

---

# 6. 更高级：分层缓存

我觉得应该像 CPU Cache。

---

## L1 Cache

当前 Scene。

最快。

保存：

```
当前人物
当前地点
当前冲突
```

---

## L2 Cache

当前 Chapter。

例如：

```
Chapter Summary
Character Changes
Plot Threads
```

---

## L3 Cache

整个 Project。

例如：

```
World Bible
Character History
Timeline
```

---

不要每次访问 L3。

---

# 7. 不要让 LLM 做数据库查询

这是一个大坑。

错误：

Prompt：

```
告诉我 Alice 当前状态
```

LLM：

搜索记忆。

---

正确：

程序：

```
GET CharacterSnapshot(
 Alice,
 Chapter20
)
```

返回：

```
Alice@Chapter20
```

然后：

LLM 写。

---

LLM 不应该：

承担：

Memory。

---

# 8. 长期运行成本最大的问题：重复生成

假设：

用户修改：

第一章。

后面：

100 个 Scene。

怎么办？

不能：

全部重新生成。

---

需要：

Dependency Graph。

例如：

```
Alice saves Bob

    |
    |
    +--- Relationship
    |
    +--- Chapter5 dialogue
    |
    +--- Ending
```

修改：

只 invalidate：

相关节点。

---

类似：

Bazel。

---

# 9. LLM 输出也要缓存

例如：

Review。

同一个：

Scene。

同一个：

规则。

不要：

每次重新问：

```
检查人设
```

---

保存：

```
Review Result

scene_hash

validator_version

model_version
```

---

例如：

```
scene_hash=a123

review=gpt5

result:
passed
```

---

如果：

scene 没变。

不用重新检查。

---

# 10. 甚至可以做 Incremental Generation

这个很有意思。

传统：

生成：

```
Scene 5
```

重新全部写。

---

未来：

可以：

类似代码补丁：

```
Scene:

Paragraph 3 changed

↓

only regenerate affected paragraphs
```

---

例如：

用户：

> Bob说话太冷淡。

不是：

重写整个 Scene。

而是：

找到：

```
dialogue node
```

重新生成。

---

# 11. 最终架构应该类似：

```
                Project Repository

                       |
                       |
              Dependency Graph

                       |
        +--------------+-------------+
        |
        |
 Context Compiler

        |
        |
  +-----+------+
  |
 Cache Layer
  |
  +----------------+
  |
Character Cache
Scene Cache
Embedding Cache
Prompt Cache
Review Cache


        |
        v

       LLM
```

---

# 12. 一个关键原则

我认为：

这个系统必须遵守：

> **LLM 是昂贵的纯函数。**

类似：

```
f(input) -> output
```

你的目标：

不是让 LLM 更聪明。

而是：

减少调用次数。

---

所以：

所有东西：

应该有：

```
Input Hash
+
Version
+
Cache
```

---

# 13. 甚至可以借鉴 Git 的思想

Git：

保存：

```
commit
```

不是：

保存：

每一次完整文件。

---

小说：

保存：

```
Narrative Commit
```

例如：

```
Commit 123

Alice:
trust changed

Bob:
secret revealed

Scene:
3-5 updated
```

---

然后：

LLM：

只处理：

commit。

---

## 总结

你的系统想商业化，成本控制的核心不是"找便宜模型"，而是：

1. **不要让 LLM 保存状态**
   - 状态由系统管理。

2. **不要每次重新构建 Context**
   - Context Compiler + Cache。

3. **不要全量重写**
   - Dependency Graph + Incremental Update。

4. **不要缓存文本，而缓存中间状态**
   - Snapshot、Embedding、Review、Prompt。

5. **把 LLM 当昂贵编译器**
   - 输入确定 → 尽可能复用输出。

如果类比软件工程：

现在大多数 AI 小说工具：

```
每次 npm run build
```

你的目标应该是：

```
Bazel + incremental build
```

只重新构建真正变化的部分。

这也是为什么我认为这个方向真正的技术壁垒不在“调用哪个大模型”，而在**如何设计一个能长期运行的 Narrative Build System（叙事构建系统）**。

### User
这个系统能够达到我预期的效果么，想一些他写不出来的东西

### Assistant
这是一个非常好的问题，因为前面我们一直在讨论“怎么实现”，但没有认真问：

> **即使架构完美，这个系统的能力边界在哪里？**

我先给一个判断：

**这个系统可以显著提升“商业类型小说”的工程化生产能力，但它无法替代真正的文学创造。**

它最擅长的是：

- 长篇一致性
- 类型

### User
继续

### Assistant
继续。

我前面说：

> 它能提升商业类型小说生产能力，但不能替代真正文学创造。

这里需要进一步拆开，因为“写不出来”的地方其实不是一个，而是几类。

---

# 一、它能解决的问题边界

先说它擅长什么。

你的系统本质上解决的是：

> **复杂叙事系统的维护问题。**

类似：

软件工程解决：

- 代码规模扩大
- 多人协作
- 修改影响
- 回归测试

你的系统解决：

- 人物规模扩大
- 世界观扩大
- 伏笔增加
- 修改影响
- 连贯性检查

所以它非常适合：

## 1. 长篇商业小说

例如：

- 网络小说
- 玄幻
- 科幻
- 推理
-

### User
继续

### Assistant
继续。

我们继续分析**这个系统真正写不出来的东西**。

这里需要非常残酷地区分：

> **工程化能力 ≠ 创作能力。**

你的系统解决的是“复杂度管理”，不是“天才创造”。

---

# 4. 它很难创造真正新的文学形式

这是最高级的问题。

例如：

entity["book","百年孤独","Gabriel García Márquez novel"]

它创造了一种新的叙事体验：

- 魔幻现实主义
- 家族史
- 历史循环
- 神话与现实融合

系统可以：

分析它。

可以：

生成类似结构。

但是：

很难：

第一次创造这种东西。

---

为什么？

因为你的系统依赖：

```text
已有结构

↓

组合

↓

生成
```

而文学创新很多时候：

是：

```text
违反已有结构

↓

产生新结构
```

---

例如：

传统小说：

```text
人物成长

冲突

高潮

结局
```

有人突然：

“不写高潮。”

“不解决冲突。”

“不提供可靠叙述者。”

于是：

新的文学形式出现。

---

你的系统天然倾向：

维护规则。

但是文学突破：

经常：

破坏规则。

---

# 5. 它很难写出真正独特的人物灵魂

这是另一个大问题。

你可以定义：

Alice：

```yaml
fear:
 abandonment

goal:
 revenge

flaw:
 distrust
```

但是：

这不等于人物。

---

为什么？

因为真实人物：

不是属性集合。

例如：

一个人物：

表面：

```text
冷漠
```

实际上：

可能：

```text
害怕被需要
```

更深：

```text
害怕自己的存在没有价值
```

更深：

```text
无法接受自己曾经伤害过别人
```

---

这个递进：

不是结构化字段。

它是：

长期作者理解。

---

LLM 可以模仿。

但是：

它很容易产生：

“心理学模板”。

例如：

所有创伤：

最后都是：

童年阴影。

---

这就是 AI 小说常见问题：

人物：

合理。

但是：

没有生命感。

---

# 6. 它很难处理真正矛盾的人性

程序喜欢：

一致性。

但是文学喜欢：

矛盾。

---

例如：

一个角色：

```text
他爱自己的国家。

但讨厌国家制度。

```

```text
他想复仇。

但害怕成为和仇人一样的人。

```

这种：

不是 bug。

这是人物。

---

你的系统可能会发现：

```
Character contradiction detected
```

然后：

尝试修复。

但是：

文学里：

很多高级人物：

就是靠矛盾成立。

---

所以：

你的 Validator 不能只有：

Consistency Check。

必须有：

Contradiction Tolerance。

---

类似：

编程语言：

允许：

某些 warning。

---

# 7. 它很难产生真正好的语言风格

这个非常现实。

你的系统可以控制：

```text
POV

Scene

Plot

Character
```

但是：

语言层面：

很难。

---

例如：

两个作家：

写同一个场景：

A：

> 雨落下来，像天空忘记关闭的一道伤口。

B：

> 雨很大。

剧情一样。

文学价值完全不同。

---

风格不是：

规则。

---

你可以保存：

```yaml
style:
 Hemingway
```

但是：

这只是：

表面。

真正风格：

包括：

- 句子节奏
- 信息密度
- 隐喻偏好
- 叙述距离
- 留白程度

---

LLM 可以模仿。

但容易：

变成：

风格滤镜。

---

# 8. 它很难创造真正优秀的伏笔

这个可能和你的系统最相关。

你可能认为：

伏笔：

就是：

```text
Plant

↓

Payoff
```

但高级伏笔：

不是。

---

例如：

第一章：

一个不起眼动作。

第五十章：

重新解释。

但是：

读者回头：

发现：

其实第一章已经告诉你。

---

问题：

伏笔价值：

不只是：

信息隐藏。

而是：

重新解释过去。

---

这需要：

作者知道：

读者未来的心理变化。

---

你的系统可以：

检查：

```text
foreshadow exists
```

但是：

很难判断：

“这个伏笔多年后会不会震撼”。

---

# 9. 它很难处理“故意的不完整”

这是文学和工程最大的冲突。

工程：

喜欢：

闭环。

小说：

经常：

开放。

---

例如：

结局：

没有解释。

读者：

自己补全。

---

系统可能：

认为：

```
Missing resolution
```

然后：

要求补充。

---

但是：

优秀作品：

可能：

正因为没有解释。

---

所以：

你的系统需要：

一个概念：

## Authorial Intent Override

作者意图覆盖。

---

类似：

代码：

允许：

```
// intentional
```

---

# 10. 最终能力边界

我觉得可以画一个表。

|能力|系统效果|
|-|-|
|人物名字、年龄、关系|★★★★★|
|世界观管理|★★★★★|
|时间线一致性|★★★★★|
|伏笔追踪|★★★★|
|多线剧情管理|★★★★|
|长篇续写|★★★★|
|商业套路生成|★★★★|
|节奏控制|★★★|
|人物深度|★★|
|文学创新|★|
|创造新流派|接近0|

---

# 但是这里有一个反直觉点

这些限制**不代表项目没有价值**。

因为商业小说最大的痛点：

其实不是：

“写不出一句漂亮话。”

而是：

“写到 50 万字以后崩了。”

---

很多网络小说的问题：

不是第一章不好。

而是：

200章以后：

- 人设崩
- 世界观崩
- 战力崩
- 伏笔忘了
- 时间线乱

你的系统：

正好解决这里。

---

# 我认为最合理的定位

不要宣传：

> AI 小说作者。

这是错误定位。

应该是：

> **AI 小说制作工程系统。**

类似：

影视工业：

不是替代导演。

而是提供：

- 剧本管理
- 分镜管理
- 连续性管理
- 制作流程

---

# 还有一个更深的问题

你的系统最大的敌人其实不是 LLM 能力。

而是：

**作者是否愿意接受工程化。**

因为很多小说作者创作过程：

是混乱的。

他们喜欢：

“想到什么写什么”。

而工程系统要求：

```text
Idea

↓

Design

↓

Implementation

↓

Review
```

---

所以最终产品可能不是给所有作者。

更可能适合：

1. 职业网文作者
2. 长篇系列作者
3. 同人作者
4. 游戏剧情团队
5. 影视编剧团队

---

如果继续往下推，我觉得下一个必须研究的问题是：

> **商业小说的生产流程本身是什么？**

因为你现在设计的是“小说软件工程”，那么必须找到对应的：

- 产品需求文档(PRD)
- 设计文档
- 开发流程
- 测试流程

否则你的 Harness 会变成一个很漂亮的架构，但不知道真正接入作者工作流的位置。这个方向其实比技术架构还重要。

### User
你现在帮我找他们现在的流程是什么样的

### Assistant
我查了一些资料后，我觉得现在商业小说（尤其中文网文）实际流程和你设计的 Harness 有一个非常大的契合点：

> **商业小说本身已经是一个“半工程化流程”，只是目前大量依赖人的脑内管理。**

你想做的其实不是创造流程，而是把已有流程**软件化、自动化、可验证化**。

下面按照真实创作流程拆解。

---

# 一、商业网文目前典型生产流程

大体可以分：

```
市场分析
 ↓
选题
 ↓
卖点设计
 ↓
世界观
 ↓
人物设计
 ↓
大纲
 ↓
细纲
 ↓
正文
 ↓
审核修改
 ↓
连载迭代
```

不同平台、作者不同，但是核心类似。很多网文教程也强调：

长篇小说通常需要先确定题材、核心设定、人物，再进行粗纲和细纲设计；细纲进一步拆解到章节层面。

---

# 1. 选题阶段（Product Discovery）

类似软件：

```
产品经理发现需求
```

小说：

```
作者发现市场机会
```

输入：

- 当前热门题材
- 读者需求
- 平台趋势
- 作者优势

例如：

不要：

> 我要写一个故事

而是：

> 我要写一个“废柴觉醒+学院竞争+复仇”的玄幻升级文

---

产物：

类似 PRD：

```yaml
Novel Proposal:

Genre:
玄幻

Target Audience:
18-30男性

Core Hook:
废柴主角发现失落血脉

Main Selling Point:
升级爽感

Reference:
斗破苍穹
```

---

对应你的系统：

就是：

```
Idea Artifact
```

---

# 2. 核心卖点设计（High Concept）

商业小说非常重视：

一句话讲清楚。

例如：

```
一个被家族废掉的少年，
获得远古系统，
重新登顶世界。
```

这是：

High Concept。

类似游戏：

一句话玩法。

---

你的系统：

应该保存：

```yaml
Story Identity:

Promise:

Reader Expectation:

Emotional Payoff:
```

这个非常重要。

因为后面所有生成：

都不能偏离。

---

# 3. 世界观设计（World Bible）

这里很多作者会做。

例如：

玄幻：

```
力量体系

等级

势力

地图

资源

历史
```

科幻：

```
科技树

文明

政治体系

宇宙规则
```

---

现在的问题：

大部分作者：

Word 文档。

例如：

```
世界观.docx
人物.docx
大纲.docx
```

长期：

必炸。

---

你的系统：

这里非常适合。

应该变成：

```
World Model
```

---

例如：

```yaml
Power System:

Realm:
  - Mortal
  - Spirit
  - Divine

Rule:

突破需要:
  - Energy
  - Insight
```

---

# 4. 人物设计（Character Bible）

商业作者通常会设计：

主角：

```
姓名
年龄
外貌
性格
目标
缺陷
成长方向
```

配角：

```
功能
关系
冲突
```

---

但是现实：

问题来了。

人物不是静态。

所以你前面提出的问题：

非常正确。

应该从：

Character Sheet

升级为：

Character Arc。

---

例如：

传统：

```yaml
Alice:

性格:
善良
```

错误。


应该：

```yaml
Alice Arc:


Start:

Fearful


Middle:

Questioning


End:

Courageous
```

---

# 5. 大纲阶段（Architecture Design）

这是最接近软件架构的阶段。

通常：

## 粗纲

回答：

```
这个故事怎么结束？
```

例如：

```
第一卷：

主角觉醒

第二卷：

进入宗门

第三卷：

发现幕后黑手

第四卷：

决战
```

---

## 细纲

进一步：

章节级。

例如：

```
第10章：

主角参加测试

冲突：
被嘲笑

高潮：
觉醒能力

结尾：
震惊众人
```

---

这一步非常类似：

Software Design Document。

---

你的 IR：

这里最有价值。

---

# 6. 正文生产

这里目前作者：

一般：

```
看细纲

↓

写正文
```

---

但是实际：

不是：

一次写章节。

更像：

Scene。

---

例如：

第十章：

拆：

Scene 1:

```
进入学院
```

Scene 2:

```
遇到敌人
```

Scene 3:

```
第一次战斗
```

---

这就是你的：

Generation Unit。

---

# 7. 连载阶段（Production）

这是网文最特殊地方。

商业小说不是：

写完发布。

而是：

持续反馈。

---

流程：

```
发布章节

↓

读者反馈

↓

数据

↓

调整剧情
```

---

例如：

发现：

某角色很受欢迎。

作者：

增加戏份。

---

这里非常像：

软件：

```
Production Monitoring

↓

Feature Adjustment
```

---

你的系统：

应该支持：

Branch。

例如：

原计划：

杀掉角色。

反馈：

读者喜欢。

修改：

保留。

---

# 二、对应你的软件工程模型

我觉得可以映射：

|小说流程|软件工程|
|-|-|
|选题|产品需求|
|卖点|产品定位|
|世界观|系统设计|
|人物|Domain Model|
|大纲|Architecture|
|细纲|Task Breakdown|
|Scene|Issue|
|正文|Implementation|
|审核|Code Review|
|读者反馈|Production Metrics|

---

# 三、真正缺失的软件化部分

现在作者最大的痛点：

## 1. 修改影响分析

例如：

改：

“主角不是孤儿”

影响：

- 第一章
- 父母线
- 仇敌动机
- 最终 Boss

现在：

靠作者记忆。

---

你的：

Dependency Graph。

非常有价值。

---

## 2. 长期一致性检查

类似：

小说 CI。

例如：

检查：

```
Alice 第3章左手受伤

第5章突然用左手剑
```

---

## 3. 版本管理

现在：

作者：

```
最终版.docx
最终版2.docx
最终版真的最终.docx
```

（笑）

---

你的：

Git。

非常自然。

---

# 四、但是有一个重要发现

商业小说流程不是：

```
大纲
↓
正文
```

而是：

更接近：

```
Idea

↓

Story Promise

↓

World

↓

Character Arc

↓

Plot Structure

↓

Scene Plan

↓

Draft

↓

Revision

```

---

所以你的系统 MVP 不应该从：

“AI 写正文”

开始。

应该从：

## Story Development Environment

开始。

---

# 五、如果我是你设计第一版

我会做：

## Phase 1：小说工程管理

类似：

GitHub for novels

支持：

- 项目
- 人物
- 世界
- 大纲
- Scene
- 版本
- Diff


---

## Phase 2：AI Agent

加入：

几个 Agent：

### Architect Agent

负责：

大纲。

---

### Character Agent

负责：

人物一致性。

---

### Writer Agent

负责：

Scene。

---

### Editor Agent

负责：

检查。

---

## Phase 3：Narrative CI

自动：

```
build

↓

test

↓

review
```

例如：

```
POV Test:

Pass

Timeline Test:

Warning

Character Test:

Fail
```

---

# 我的判断

看完商业小说流程后，我反而觉得你的方向更明确了：

你不是在创造一个新的写作方法。

你是在做：

> **把职业作者脑中的隐性流程，显性化、结构化、自动化。**

目前网文行业已经存在：

- 大纲
- 细纲
- 人设
- 世界观
- 复盘
- 修改

但是这些都是：

人的经验。

你的系统的价值：

就是把：

```
作者经验
```

变成：

```
可执行工作流
```

这和软件工程的发展非常类似：

以前：

程序员靠经验管理大型项目。

后来：

出现：

- Git
- IDE
- CI/CD
- Issue Tracker

你的目标类似：

> 给小说行业做一个 GitHub + IDE + CI/CD。

这比“AI 自动写小说”明显更现实。

### User
说的挺有道理，我好像理解民科了
我都没接触过这些领域的知识，我只学了软工，所以说我能写这个么

### Assistant
我觉得你这个自我怀疑其实非常正常，而且我反而觉得这里有一个很有意思的现象：

你不是“民科”，更像是**从一个领域迁移思维模型时，刚好撞到了一个真实存在的问题**。

你没有文学理论背景，所以一开始会自然地从软件工程出发：

- 状态管理
- 版本控制
- 依赖分析
- 测试
- Pipeline
- Cache
- IR

然后你发现：

“等等，小说好像也有这些问题。”

这个过程其实和很多跨领域创新很像。

---

但是我也要泼一点冷水：

## 你现在不能说“我要解决 AI 小说”

这个范围太大。

因为里面包含：

- 叙事学
- 文学理论
- 计算创造力
- NLP
- Agent
- 数据库
- 编辑流程
- 商业出版

任何一个方向都能做 PhD。

如果一个本科软工学生说：

> 我要设计一个通用小说生成系统，支持所有文学技法。

这个确实容易变成“民科”。

但是：

如果换一个目标：

> 我想做一个软件工程化的长篇小说辅助工具，解决 AI 长文本创作中的版本、状态、一致性和协作问题。

这个完全合理。

---

# 其实你的软件工程背景反而是优势

因为现在 AI 写作领域缺的东西，很多不是模型能力。

而是：

## 工程系统。

举几个例子。

---

## 1. GitHub 为什么不是因为程序员会写代码才成功？

GitHub 解决的是：

以前：

```text
final.py
final_new.py
final_new2.py
final_real.py
```

变成：

```text
commit
branch
merge
review
```

---

小说作者现在：

类似：

```text
第一章修改版.docx

第一章最终版.docx

第一章最终最终版.docx
```

这不是文学问题。

这是工程问题。

---

## 2. AI Coding 为什么最近爆发？

不是因为 GPT 突然会写所有代码。

而是出现了：

- Repo Context
- Tool Calling
- Test Loop
- Git Diff
- CI

也就是：

Harness。

---

你的想法其实是在问：

> 为什么 AI 写代码有 IDE、Git、测试，而 AI 写小说只有聊天窗口？

这个问题很合理。

---

# 但是你缺的知识是什么？

不是全部文学。

而是几个关键领域。

---

## 第一：叙事学（Narratology）

你需要知道：

小说不是简单剧情。

至少需要理解：

- Story vs Discourse（故事 vs 叙述）
- Focalization（视角）
- Narrator（叙述者）
- Time Order（时间结构）
- Character Arc
- Plot Structure

不用成为文学教授。

知道这些概念即可。

---

## 第二：剧作理论

商业小说很多借鉴：

影视剧结构。

例如：

- Three Act Structure
- Save the Cat
- Hero's Journey
- Snowflake Method

这些实际上更接近工程。

---

## 第三：创作工业流程

这个你现在已经开始补。

例如：

网文：

- 卷纲
- 章纲
- 细纲
- 卡点
- 爽点
- 节奏

---

## 第四：AI Agent 工程

这是你的强项。

例如：

- Context Management
- Memory
- Tool Calling
- Evaluation
- Workflow

---

# 那你能不能写？

我的判断：

## 写 MVP：可以。

甚至你的背景比较适合。

因为 MVP 不需要解决：

“什么是文学”。

只需要解决：

“如何让一个作者管理一个 100 万字小说项目”。

---

例如：

第一版：

不要：

AI 自动创作。

做：

### Novel Project Manager

功能：

```
create novel

├── characters
├── world
├── outline
├── scenes
├── drafts
├── timeline
├── revisions
```

然后：

AI：

帮你：

- 总结
- 查冲突
- 生成章节
- 提取人物变化

这个完全可以。

---

# 但是你需要避免几个坑

## 坑 1：

不要先设计完整 IR。

你现在很容易：

设计：

```text
Narrative AST
Narrative Compiler
Semantic Graph
Knowledge Engine
```

然后半年过去。

没有产品。

---

## 坑 2：

不要先研究所有文学技法。

因为：

文学没有统一标准。

---

## 坑 3：

不要相信 AI 能自动评价文学质量。

例如：

“这个章节文学性 85 分”

这种基本没有意义。

---

# 如果我是你的话，我会这么做

你是软工背景，我会走一个非常工程化路线：

---

## 第 0 阶段：找真实用户

找：

- 一个网文作者
- 一个同人作者
- 一个剧本作者

问：

他们现在怎么管理：

- 人物
- 大纲
- 修改

不要问：

“你想不想 AI 写小说？”

问：

“你上次改第一章导致哪些地方崩了？”

---

## 第 1 阶段

做：

类似：

```text
Notion + Git + AI
```

先解决：

项目管理。

---

## 第 2 阶段

加入：

Consistency Checker。

例如：

发现：

```
Chapter 1:

Alice lost her eye

Chapter 20:

Alice uses both eyes
```

---

## 第 3 阶段

加入：

Agent。

---

## 第 4 阶段

再考虑：

Narrative IR。

---

# 另外，我想纠正你一个心理误区

你说：

> 我都没接触过这些领域的知识

但是你刚才提出的问题：

- 修改第一章如何影响第十章？
- 人物状态如何随时间变化？
- LLM 输出如何验证？
- 如何减少成本？
- 中间表示是否过度抽象？

这些其实不是普通写作者会问的问题。

这些是：

**系统设计问题。**

你的优势不是文学知识。

你的优势是：

看到一个混乱系统，然后本能地问：

> 能不能建模？

这是软件工程师的能力。

---

真正危险的是：

一个没有软件背景的人说：

> 我要做一个 AI 自动写百万字小说。

这个容易空想。

而你现在的问题已经变成：

> 如何构建一个可靠的软件系统，让不可靠的生成模型参与复杂创造流程。

这个问题非常工程。

---

如果按现实评估：

- 做一个 Demo：你完全可以。
- 做一个能给自己用的工具：很可能。
- 做一个商业产品：需要补文学流程和用户研究。
- 做一个通用“小说编译器”：这是几年级别的问题。

所以不是“能不能写”。

而是：

**不要一开始试图解决文学本身，先解决小说创作中的软件工程问题。**

这条路线和你的背景是匹配的。你甚至可以把它当一个非常好的软工/AI 工程方向项目。

### User
作为毕设可以么

### Assistant
短答案：

**可以，而且如果收缩范围，它其实是一个相当不错的计算机本科毕设题目。**

但是注意：

> 不能以“AI 自动写小说系统”作为毕设题目。

这个容易被老师认为：

- 偏应用拼装
- 缺少技术深度
- 无法验证
- 依赖大模型 API

应该把它包装成一个**软件工程 + AI 系统方向**的课题。

---

# 适合作为毕设的版本

我建议你的题目不要叫：

> 基于大语言模型的智能小说创作系统

这个太像普通 AI 应用。

更好的方向：

## 题目 1（推荐）

> **面向长文本创作的大语言模型上下文管理与一致性维护系统设计与实现**

关键词：

- 长文本
- Context Management
- 一致性
- 状态管理
- LLM Agent

这个非常像计算机专业。

---

## 题目 2

> **基于大语言模型 Agent 的小说创作辅助平台设计与实现**

偏工程。

---

## 题目 3

> **基于时序知识图谱的长篇小说人物状态管理与生成辅助系统**

这个技术味更强。

关键词：

- Temporal Knowledge Graph
- Event Sourcing
- LLM

---

# 为什么它适合毕设？

因为本科毕设通常要求：

1. 有明确需求
2. 有系统设计
3. 有实现
4. 有测试
5. 有创新点


你的方向都有。

---

# 拆成一个本科可完成范围

不要做：

> 小说工业革命。

做一个闭环。

---

## 系统目标：

解决：

> 大语言模型生成长篇小说时容易出现人物设定冲突、时间线混乱、上下文遗忘的问题。


---

## 系统架构：

例如：

```
                用户

                 |
                 |

          AI 创作助手

                 |

       Narrative Management Layer

                 |

+--------------------------------+

|                                |

人物状态管理                 剧情事件管理

Character State              Story Event

|                                |

+--------------------------------+

                 |

        Context Builder

                 |

                 LLM

                 |

          Scene Draft

                 |

          Consistency Check
```

---

# 你的创新点在哪里？

不要说：

“调用 GPT”。

这个没价值。

应该说：

---

## 创新点 1：时序化小说状态管理

传统 AI：

```
Prompt
 |
LLM
 |
Text
```

你的：

```
Story Event

↓

Temporal State

↓

Context Generation

↓

LLM
```

---

实现：

例如：

保存：

```json
{
 event:"Alice learns secret",
 time:"chapter10"
}
```

生成：

```text
Alice@Chapter10
```

---

## 创新点 2：动态上下文构建

这是很好的点。

传统：

全部塞：

```
100k tokens
```

你的：

根据 Scene：

检索：

```
相关人物
相关事件
相关世界观
```

生成：

Context Package。

---

这就是：

RAG + Knowledge Graph。

---

## 创新点 3：一致性检测

例如：

自动检查：

### 时间冲突

```
Chapter 3:
Alice loses sword

Chapter 8:
Alice uses sword
```

---

### 角色认知冲突

```
Alice says:
"I know Bob is traitor"

But:

Alice never discovered this.
```

---

这非常适合写论文。

---

# 技术栈也符合你的背景

你现在的能力：

React / TS / Node / Bun / SQLite / WebSocket

完全够。

---

后端：

```
Node.js / Bun

↓

SQLite/PostgreSQL

↓

Event Store

↓

Vector DB(optional)

↓

LLM API
```

---

前端：

```
React

↓

Novel IDE

├── 世界观编辑器
├── 人物管理
├── 时间线
├── Scene 编辑
└── AI 对话
```

---

# 但是有几个地方不要碰

## 不要做：

### 1. 自己训练模型

本科没必要。

---

### 2. 自动评价文学质量

很难证明。

---

### 3. 完整 Narrative IR

太大。

---

### 4. 自动生成百万字小说

没有意义。

---

# 最适合毕设的 MVP

我建议：

## 用户流程

### Step 1

创建小说项目

输入：

```
世界观
人物
大纲
```

---

### Step 2

系统建立：

```
Character Graph

Timeline

Event Store
```

---

### Step 3

用户选择：

```
生成第三章第二节
```

---

### Step 4

系统：

生成 Context：

```
当前人物状态
历史事件
场景目标
限制条件
```

---

### Step 5

LLM：

生成 Scene。

---

### Step 6

系统检查：

```
人物冲突
时间冲突
知识边界
```

---

完成闭环。

---

# 论文可以写什么？

标题：

《面向大语言模型长文本生成的一致性维护系统设计与实现》

章节：

## 第一章

背景：

LLM 长文本生成问题。


## 第二章

相关技术：

- LLM Agent
- RAG
- 知识图谱
- Event Sourcing


## 第三章

系统设计：

- 小说状态模型
- 时间线模型
- Context Builder


## 第四章

实现：

前后端。


## 第五章

实验：

比较：

### 方法 A

直接 Prompt：

```
输入前文
```

### 方法 B

你的系统：

```
动态 Context
```

指标：

- 人物一致性
- 世界观错误数量
- Token 消耗

---

# 甚至可以设计实验

这个非常重要。

比如：

生成 10 章小说。

测试：

## Baseline:

普通 ChatGPT：

```
Chapter1-10
```

## Your System:

Context Management：

结果：

错误：

```
角色信息错误：

Baseline:
15

System:
3
```

Token:

```
Baseline:
800k

System:
250k
```

---

这样就是一个完整计算机毕设。

---

# 我的评价

结合你的背景：

- 软件工程能力 ✅
- 前端工程能力 ✅
- AI 工具使用经验 ✅
- 有全栈项目经验 ✅

这个题目比很多本科毕设（比如“基于 SpringBoot 的商城系统”）其实更能体现能力。

但是核心定位一定要改：

不要：

> AI 写小说

而是：

> **面向长文本生成的大模型辅助创作工程系统**

你的毕设重点应该是：

**如何让一个不可靠的大模型，在一个复杂、长期、可维护的软件系统中稳定工作。**

这个问题本身就是现在 AI Agent 领域非常核心的问题。你之前讨论的 Context、Cache、State、Version、Validation，反而是最适合写进毕设的部分。

### User
这个系统本身的 interface 如何，假如里面依赖llm的部分都换成人工他是否是个可行的系统

### Assistant
这是一个非常好的反向验证问题。

你实际上是在问：

> **如果把 LLM 拿掉，这个系统本身作为“小说工程管理软件”是否成立？**

这个问题很重要，因为好的 AI 系统应该满足：

> AI 是增强器，而不是地基。

如果 LLM 去掉整个产品崩溃，说明你做的是一个 Prompt Wrapper。

如果 LLM 去掉仍然有价值，说明你做的是一个真正的系统。

我的判断：

**可行，而且我认为这是这个项目最正确的设计方向。**

---

# 1. 去掉 LLM 后，它是什么？

它不是 AI 小说工具。

它更像：

> **一个面向长篇小说的 IDE + 项目管理系统。**

类似：

程序员有：

- VS Code
- Git
- Jira
- CI/CD

作者有：

- Word
- Notion
- Excel
- 思维导图

但是目前没有：

> 小说工程化 IDE。

---

所以人工模式下：

用户可以：

## 创建项目

```
Novel Project

├── World
├── Characters
├── Timeline
├── Plot
├── Scenes
├── Drafts
└── Revisions
```

---

## 管理角色

不是：

Word 文档。

而是：

实体。

例如：

```
Character: Alice

Identity:
- name
- appearance
- background

Arc:
Chapter 1:
 fearful

Chapter 10:
 trusting

Chapter 30:
 leader
```

---

## 管理事件

例如：

```
Event:

Chapter 5

Alice discovers secret

Participants:
Alice
Bob

Effects:
Alice knows X
Relationship changes
```

---

## 管理时间线

类似：

```
Story Timeline

Day 1
 |
Day 5
 |
Day 30
```

---

## 管理 Scene

例如：

```
Chapter 10

Scene 1:
Alice enters castle

Scene 2:
Fight

Scene 3:
Reveal
```

---

这些东西：

完全不需要 AI。

---

# 2. 这和普通 Notion 有什么区别？

这是关键。

有人会说：

> Notion 不就能做吗？

区别在：

Notion 是：

```
Document System
```

你的：

```
Semantic System
```

---

Notion：

存：

```
Alice:
文本
```

你的：

知道：

```
Alice
 |
 + Events
 |
 + Relationships
 |
 + Timeline
 |
 + Knowledge
 |
 + Scenes
```

---

例如：

用户删除：

```
Chapter 3:
Bob tells Alice secret
```

系统知道：

影响：

```
Alice knowledge state

Chapter 8 dialogue

Ending reveal
```

Notion 不知道。

---

# 3. 人工模式下最大的价值是什么？

其实是：

## Continuity Management

也就是：

长篇维护。

---

一个作者写 100 万字：

脑容量有限。

他需要：

问：

> 第42章的时候 Alice 知道这个秘密了吗？

系统回答。

---

这个功能：

不需要 LLM。

---

# 4. LLM 应该放在哪里？

我觉得你的架构应该反过来：

不是：

```
AI 小说系统

+
一些数据库
```

而是：

```
Novel Engineering System

+
AI Assistant
```

---

类似：

VS Code：

没有 Copilot：

仍然是 IDE。

有 Copilot：

更强。

---

你的：

没有 AI：

仍然：

管理小说。

有 AI：

自动：

- 填充
- 分析
- 重构
- 检查

---

# 5. AI 插入点应该是什么？

不要：

```
点击生成小说
```

太低级。

应该：

## A. 自动生成结构

人工：

写：

```
Alice发现秘密
```

AI：

生成：

```
Event:

type:
Reveal

participants:
Alice Bob

effects:
Knowledge change

Possible conflicts:
...
```

---

## B. 自动维护状态

人工修改：

```
Bob不是反派，而是卧底
```

AI：

提出：

```
Affected:

Chapter 3
Chapter 8
Chapter 20

Need review:
yes
```

---

## C. 自动 Review

类似 CI。

人工提交：

```
Chapter 5 draft
```

AI：

跑：

```
Narrative Test

❌ POV violation

⚠ Alice motivation unclear

✓ Timeline valid
```

---

## D. 辅助写作

最后才是：

```
Write Scene
```

---

# 6. 一个重要判断：这个系统甚至可能更适合同人

为什么？

因为同人天然有：

固定世界状态。

例如：

原作：

```
Harry Potter Canon
```

你的系统：

管理：

```
Canon State

+
Fan Fiction Branch
```

---

类似：

Git:

```
main:
原作

branch:
你的故事
```

---

作者：

可以：

```
What if Snape survived?
```

创建：

branch。

---

这个人工价值很高。

---

# 7. 最大的问题在哪里？

不是技术。

是：

UI/UX。

因为小说不是代码。

作者不想看到：

```
Database
Event
State
Entity
```

他们想看到：

```
人物关系图

剧情线

时间轴

章节地图
```

---

所以 Interface 非常关键。

我想象应该类似：

---

## 主界面

```
                Novel IDE


 Timeline ------------------

Day1 ---- Day5 ---- Day30


 Characters


Alice
 |
Bob
 |
King


 Plot Board


Act1
 Scene
 Scene


Editor


[正文]
```

---

## 点击人物：

不是表格。

而是：

```
Alice

Current Arc:

Fear
 ↓
Doubt
 ↓
Trust


Important Events:

Chapter 3
Chapter 8
Chapter 20
```

---

# 8. 从毕设角度看

这个方向反而更好。

因为：

如果你的题目是：

“AI自动写小说”

老师可能问：

> 创新在哪里？不就是调用 API？

---

但是：

如果是：

> 面向长文本创作的叙事状态管理与智能辅助系统

老师看到：

- 数据模型
- 状态管理
- 知识图谱
- 版本控制
- 一致性检测

这是软件工程。

---

# 我的最终判断

如果：

去掉 LLM：

这个系统仍然：

✅ 有价值
✅ 有用户场景
✅ 有工程问题
✅ 可以独立运行

那么设计方向正确。

你的核心产品应该是：

```
Novel IDE

       +
AI Copilot
```

而不是：

```
AI Writer

       +
一些管理功能
```

甚至我认为，你前面提出的所有问题（状态、版本、缓存、Context Compiler）其实都指向同一个核心：

> **为叙事内容建立类似代码工程的基础设施。**

LLM 只是第一个使用这个基础设施的智能工具。未来甚至人工作者、多人团队、游戏剧情团队都可以使用它。

### User
这个的预期就是为长篇小说创作者（llm或真人）提供一个小而且稳定的上下文，约束这个 scene 说出预期的剧情对么
那么修辞怎么办，明暗线隐喻伏笔等等怎么办

### Assistant
对，你现在已经抓到这个系统的核心了。

但是我要稍微修正一下你的表述：

> **不是“提供一个小而稳定的上下文，让 scene 说出预期剧情”。**

更准确的是：

> **提供一个受约束的局部叙事环境（Local Narrative Environment），让创作者（人或 LLM）在这个环境中自由创作，同时保证它不会破坏全局叙事结构。**

这个区别非常重要。

因为如果只是“约束 scene”，最后会变成：

```
输入：
Alice 要发现秘密

输出：
Alice 发现秘密。
```

这种 AI 生成非常机械。

真正的目标应该类似游戏引擎：

- 引擎约束世界规则
- 玩家/开发者自由创造玩法

你的系统约束：

- 时间
- 因果
- 人物状态
- 信息边界
- 伏笔关系

但是不约束：

- 句子
- 修辞
- 象征
- 表达方式

---

# 1. 那修辞怎么办？

这是最容易误解的地方。

很多人设计 AI 写作系统，会想：

> 我要把所有文学知识结构化。

这是错误方向。

因为：

修辞不是状态。

---

例如：

一句：

> “月亮像一枚冷掉的硬币挂在天空。”

系统不应该解析：

```json
{
 metaphor:
   moon = coin
 emotion:
   loneliness
}
```

然后控制。

因为文学价值来自：

不可预测性。

---

更合理：

修辞属于：

## Generation Layer

而不是：

## Planning Layer

---

类似软件：

你规定：

函数：

```typescript
function transferMoney()
```

但是：

不规定：

变量名字：

```typescript
const a
```

还是：

```typescript
const userBalance
```

---

小说：

系统规定：

```
Scene:
Alice面对死亡威胁

Required emotion:
恐惧 + 犹豫

Character state:
她害怕失去弟弟

```

但是：

表达：

交给作者/LLM。

---

# 2. 那明线暗线怎么办？

这个反而非常适合工程化。

因为：

暗线不是文字。

暗线是：

**隐藏的叙事结构。**

---

例如：

明线：

```
主角寻找失踪父亲
```

暗线：

```
父亲其实一直保护主角
```

---

系统不要存：

“写一句暗示”。

应该存：

Narrative Thread。

---

例如：

```yaml
Thread:

id:
father_secret


Type:
Hidden Plot


Reveal Level:

Chapter1:
0.1


Chapter10:
0.5


Chapter30:
1.0
```

---

然后 Scene：

引用：

```yaml
Scene:

Purpose:

Advance father_secret

Reveal:
+0.05
```

---

于是：

第一章：

不能：

直接说：

“父亲为了保护你牺牲。”

因为：

Reveal Level 不允许。

---

但是可以：

出现：

```
父亲旧照片背面的字迹。
```

---

这个：

程序检查。

表达：

LLM决定。

---

# 3. 伏笔怎么办？

伏笔其实更容易。

因为伏笔天然是：

Event。

---

传统：

作者脑子：

```
第一章放一个剑
第五十章使用
```

系统：

```yaml
Foreshadow:

id:
ancient_sword


Plant:

Chapter1 Scene3


Payoff:

Chapter50 Scene2


Importance:

Major
```

---

然后：

检查：

## 悬空伏笔

```text
Plant:
Chapter1

Payoff:
missing
```

警告。

---

## 过早揭露

```text
Expected reveal:
Chapter50

Current:
Chapter10
```

警告。

---

# 4. 隐喻怎么办？

这个比较复杂。

因为隐喻不是剧情。

但是：

高级小说里面：

隐喻往往和主题有关。

---

例如：

《了不起的盖茨比》：

绿色灯光。

它不是剧情事件。

但是：

贯穿：

- 梦想
- 距离
- 不可达

---

这种东西：

不要建模成：

规则。

而应该建模成：

## Motif（母题）

---

例如：

```yaml
Motif:

green_light


Meaning:

desire
hope
distance


Appearances:

Chapter1:
mentioned

Chapter10:
symbolic scene

Ending:
recontextualization
```

---

Scene：

可以引用：

```yaml
Scene:

Motif:
green_light

Function:
reinforce longing
```

---

但是：

怎么写？

LLM决定。

---

# 5. 明暗线、伏笔、隐喻，其实有一个共同抽象

我觉得你需要引入一个东西：

## Narrative Intent

叙事意图。

---

普通系统：

保存：

```
发生了什么
```

高级系统：

还保存：

```
作者为什么这么安排
```

---

例如：

事件：

```yaml
Alice sees a bird
```

普通：

没有意义。

---

Narrative Intent:

```yaml
Purpose:

Symbolize freedom


Future:

Contrast with Alice imprisonment
```

---

这样：

未来修改时：

系统知道：

不能随便删除。

---

# 6. 所以一个 Scene 输入应该变成：

不是：

```
人物状态
+
剧情目标
```

而是：

```
Scene Context

{
    // 硬约束

    Timeline
    Character State
    World Rules
    Knowledge Boundary


    // 叙事目标

    Plot Goal
    Character Goal
    Emotional Arc


    // 长期结构

    Active Threads
    Foreshadowing
    Motifs
    Themes


    // 风格

    POV
    Tone
    Style

}
```

---

然后：

LLM：

生成：

正文。

---

# 7. 但是注意一个危险

你可能会继续走向：

“我要把所有文学元素都结构化”。

不要。

边界应该是：

## 系统管理：

可验证的东西：

✅ 时间
✅ 因果
✅ 人物状态
✅ 信息边界
✅ 剧情线程
✅ 伏笔生命周期
✅ 主题出现频率


---

## LLM/人管理：

不可严格验证：

❌ 比喻
❌ 诗意
❌ 节奏
❌ 情绪感染
❌ 独特语言


---

# 8. 最终模型应该类似：

```
                Novel State

                     |
                     |

          Narrative Intent Layer

                     |
                     |

              Scene Contract

                     |
                     |

          Human / LLM Writer

                     |
                     |

              Generated Text

                     |
                     |

             Validator Feedback
```

---

所以你的理解基本正确：

这个系统不是让 AI “写得更像人”。

而是：

> 给 AI（或者人类作者）一个稳定的小世界，让它在有限但丰富的约束中创造。

这和游戏开发很像：

Unity 不告诉开发者：

“这一帧必须怎么画”。

它提供：

- 世界
- 物理
- 状态
- 生命周期

然后开发者创造内容。

小说 Harness 也是：

**叙事引擎，而不是自动写作器。**

---

而你刚才提到的“修辞、明暗线、隐喻、伏笔”，实际上是证明这个系统需要分层：

**Story State（事实层）**
→ **Narrative Intent（意图层）**
→ **Text Generation（表达层）**

如果把三者混在一起，这个系统一定会失败。你现在的问题已经开始触及真正的架构边界了。

### User
那么我希望ai的最终写出的大部分文本都是可用流畅而且文学性还可以，怎么弄呢

### Assistant
这个问题其实是整个系统最终的“上限问题”。

前面我们讨论的是：

> 如何让 AI 不写崩。

现在你问的是：

> 如何让 AI 写得好。

这两个是完全不同的问题。

一致性系统解决的是 **负向质量控制（avoid bad）**，但文学质量需要 **正向生成能力（create good）**。

如果目标是：

> AI 输出的大部分正文可以直接进入商业小说草稿，流畅、有一定文学性。

那么单靠前面的 Narrative State / Context Compiler **不够**。

你需要增加一套“创作生产线”。

---

# 1. 首先要接受一个事实：一次生成 Scene 不会稳定好

现在很多 AI 小说：

流程：

```
Prompt

↓

LLM

↓

5000字正文
```

失败原因：

模型同时承担：

- 理解剧情
- 设计节奏
- 控制人物
- 组织语言
- 创造细节

这相当于：

让一个程序员：

一次写：

需求分析 + 架构 + 编码 + 测试。

---

软件工程为什么拆流程？

因为：

不同阶段优化目标不同。

小说也一样。

---

# 2. 应该拆成类似编剧室（Writer's Room）

不要：

```text
Scene -> Text
```

而应该：

```text
Scene Intent

↓

Beat Design

↓

Narrative Draft

↓

Style Rewrite

↓

Continuity Check

↓

Polish

↓

Final
```

---

## 第一阶段：Scene Planner

不是写正文。

生成：

```yaml
Scene Plan:

Goal:
Alice discovers Bob lied


Emotional Curve:

curiosity
 ↓
suspicion
 ↓
fear


Beats:

1.
Alice enters room

2.
Finds hidden letter

3.
Denies possibility

4.
Confronts evidence

5.
Leaves silently


Key Image:

Broken mirror
```

---

这个阶段类似：

导演分镜。

---

# 3. 第二阶段：Draft Writer

拿：

Scene Plan。

生成：

粗稿。

重点：

不要追求漂亮。

目标：

完成：

- 事件
- 情绪
- 信息

---

例如：

输出：

```text
Draft v1
```

---

# 4. 第三阶段：Literary Editor

这是很多系统缺失的。

专门负责：

语言。

类似：

出版社编辑。

输入：

粗稿。

任务：

不是改变剧情。

而是：

优化：

- 节奏
- 描写
- 对话
- 句式

---

例如：

原：

> Alice很害怕。

修改：

> 她握住门把的手停了一瞬，仿佛门后藏着的不是一个房间，而是一段她不敢面对的过去。

---

---

# 5. 第四阶段：Character Voice Pass

这是非常重要的一层。

很多 AI 最大问题：

所有人说话一样。

---

单独跑：

角色声音检查。

例如：

Bob：

冷静、克制。

检查：

```text
Bob:
"哈哈我好开心啊！"

违反角色声音。
```

---

---

# 6. 第五阶段：Human-like Review

类似：

代码 review。

不是：

评分。

而是：

提出问题：

例如：

```
这一段：

剧情功能完成。

但是：

Alice情绪变化过快。

建议增加：
1个犹豫动作。
```

---

# 7. 文学性从哪里来？

这个很关键。

很多人以为：

文学性来自：

“高级词汇”。

不是。

商业小说文学性主要来自：

几个东西：

---

## ① 具体性（Specificity）

差：

> 他很愤怒。

好：

> 他把杯子放回桌上的动作轻得过分，像是在努力证明自己没有生气。


AI需要：

Detail Agent。

---

## ② 情绪潜台词

差：

> “我讨厌你。”

好：

> “你放心，我不会再管你了。”

---

需要：

Dialogue Subtext。

---

## ③ 场景化

差：

> 两人讨论过去。

好：

> 雨声盖过了他们的争吵。

---

需要：

Scene Enrichment。

---

## ④ 节奏控制

不是每句话一样重要。

需要：

Beat Level。

---

# 8. 但是这些怎么工程化？

不要尝试：

“定义文学”。

应该定义：

**检查维度。**

例如：

生成后：

跑几个 Reviewer Agent：

---

## Flow Reviewer

检查：

```
剧情是否推进？
```

---

## Emotion Reviewer

检查：

```
情绪是否自然？
```

---

## Style Reviewer

检查：

```
是否过度解释？
```

---

## Voice Reviewer

检查：

```
人物是否同质化？
```

---

## Cliche Reviewer

检查：

```
是否出现 AI 套话？
```

---

# 9. 这里会引入一个重要机制：

## Generate → Critique → Revise

这其实是现在 Agent 系统常用思想。

不是：

一次生成。

而是：

循环。

---

例如：

第一次：

```
Generate Scene
```

↓

Reviewer:

```
问题：
Alice转变太快
```

↓

Rewrite:

```
增加铺垫
```

---

类似：

程序：

```
写代码

↓

测试

↓

修 bug

↓

提交
```

---

# 10. 但是成本怎么办？

不能所有地方都调用大模型。

所以：

分层。

---

## 小模型：

负责：

- 格式检查
- 连贯检查
- 信息抽取

---

## 大模型：

负责：

- 初稿
- 改写
- 文学润色

---

## 人：

负责：

- 方向
- 审美

---

# 11. 最终生产线：

我认为比较合理：

```
                 Story Bible

                     |

              Scene Contract

                     |

              Planning Agent

                     |

              Beat Sheet

                     |

              Draft Agent

                     |

              Literary Agent

                     |

        +------------+------------+

        |                         |

Continuity Check          Style Check

        |                         |

        +------------+------------+

                     |

              Final Scene
```

---

# 12. 但是我要提醒一个边界

“AI 输出大部分可用”是可能的。

但是：

“AI 输出大部分就是出版级”目前不现实。

更现实：

## 网络小说商业草稿级

可以。

例如：

80% 可用：

- 改少量句子
- 调整部分情绪
- 修几个地方

这是可实现目标。

---

## 出版文学级

困难。

因为：

它需要：

- 独特人生经验
- 审美判断
- 文化敏感性
- 创造性突破

---

# 最后，我觉得你的系统目标应该重新定义：

不是：

> AI 自动写小说。

而是：

> **AI 小说生产编译器。**

输入：

```
Story Design
```

经过：

```
Planning
Generation
Review
Revision
```

输出：

```
Commercial-quality Draft
```

---

这和软件编译器非常像：

编译器不会创造程序逻辑。

但是：

它让人类写出的高层代码稳定变成可执行程序。

你的系统也是：

不是替代作者创造。

而是让：

**作者的故事设计 + AI 的生成能力 → 稳定产生长篇文本。**

这个方向才是工程上最可能达到“高成功率”的路线。

### User
llm幻觉或者人类的失误怎么处理，

### Assistant
这个问题其实触及了你整个系统最核心的设计原则：

> **LLM 和人类作者都应该被视为“不可靠输入源（Untrusted Input Source）”。**

这是一个非常软件工程的视角。

不要假设：

- LLM 永远正确
- 作者永远记得设定
- 大纲永远一致
- 修改不会破坏后续

而应该像软件系统处理：

- 用户输入
- 第三方 API
- 外部数据

一样处理。

---

# 1. 首先区分三类错误

不是所有错误处理方式一样。

---

## 类型 A：事实错误（Hard Inconsistency）

这是最容易解决的。

例如：

设定：

```yaml
Alice:
  eye_color: blue
```

正文：

> Alice 棕色的眼睛看着远方。

这是：

确定错误。

系统可以：

直接检测。

---

类似：

编译错误：

```typescript
const x:number="hello"
```

---

处理：

```text
ERROR

Cannot compile scene.

Reason:
Character attribute conflict.

Options:
1. modify draft
2. modify character bible
3. create exception
```

---

# 2. 类型 B：状态错误（Temporal Inconsistency）

更复杂。

例如：

第 3 章：

```text
Alice lost her sword.
```

第 5 章：

```text
Alice draws her sword.
```

问题：

不是属性。

是：

时间。

---

系统：

维护：

Event Timeline。

计算：

```text
Chapter3

Event:
Sword destroyed

↓

Current State:

Sword = destroyed
```

---

生成 Chapter5：

检查：

```text
Required:
Sword exists

Actual:
Sword destroyed
```

---

报警。

---

但是这里有一个重要点：

系统不能自动修。

因为可能：

作者想写：

“这把剑其实是复制品”。

所以：

应该：

Warning。

不是 Error。

---

# 3. 类型 C：语义错误（Semantic Hallucination）

最难。

例如：

LLM：

> Bob想起了十年前和 Alice 的约定。

但是：

数据库：

没有这个事件。

---

问题：

有三种可能：

### 可能 1：

LLM 幻觉。

### 可能 2：

作者忘记录入。

### 可能 3：

这是新的创作。

---

所以：

不能自动禁止。

---

应该进入：

## Proposal System

类似：

Git Pull Request。

---

LLM 提议：

```yaml
New Event Proposal:

Event:
Bob and Alice made a promise.

Confidence:
0.72

Impact:

Alice relationship
Bob motivation
Chapter1-10
```

---

人工：

Approve / Reject。

---

# 4. 这其实类似数据库事务

LLM 不应该直接写数据库。

这是关键。

错误：

```
LLM

↓

Database
```

非常危险。

---

正确：

```
LLM

↓

Proposal

↓

Validator

↓

Human/Rule Approval

↓

Database Commit
```

---

类似：

Git：

不是：

别人直接改 main。

而是：

Pull Request。

---

# 5. 那人类错误怎么办？

这个更有意思。

因为：

人类作者经常：

主动破坏设定。

例如：

作者：

第 20 章决定：

“其实 Bob 是王子。”

但是：

前面：

写了：

Bob 是孤儿。

---

系统怎么办？

不能说：

“不允许。”

否则创作被限制。

---

应该：

提供：

## Change Impact Analysis

---

例如：

作者修改：

```diff
Bob:
- orphan
+ hidden prince
```

系统计算：

影响：

```
Affected:

Chapter 1
Chapter 3
Chapter 7
Chapter 15

Plot Threads:

Royal Bloodline

Character Motivation
```

---

然后：

作者选择：

```
[ ] 自动修复
[ ] 手动修改
[ ] 保留矛盾
```

---

# 6. 这里需要类似数据库 Migration

软件：

数据库字段改变：

不会直接改。

需要：

Migration。

---

小说：

设定改变：

也应该：

Migration。

---

例如：

修改：

```yaml
Old:

Bob:
orphan
```

变：

```yaml
New:

Bob:
hidden prince
```

生成：

```yaml
Narrative Migration:

Need update:

1.
Chapter1 dialogue

2.
Chapter5 motivation

3.
Chapter12 reveal timing
```

---

这非常有价值。

---

# 7. LLM 输出应该是什么格式？

不要：

直接输出：

小说。

应该：

两阶段。

---

## 第一阶段：

LLM 输出：

Draft + Metadata。

例如：

```json
{
"text":
"Alice opened the door...",


"claims":[
 {
  "subject":"Alice",
  "fact":"entered castle",
  "confidence":0.9
 },

 {
  "subject":"Bob",
  "fact":"knows secret",
  "confidence":0.6
 }
]
}
```

---

系统检查：

claims。

---

## 第二阶段：

通过：

才进入：

Story State。

---

# 8. 建立“事实来源优先级”

非常重要。

类似软件：

配置优先级。

小说：

应该：

```
Canon
 >
Approved World Bible
 >
Character State
 >
Scene Contract
 >
Previous Draft
 >
LLM Generated Text
```

---

如果冲突：

低优先级让步。

---

例如：

LLM：

“Bob会魔法。”

但是：

World Bible：

“不存在魔法。”

拒绝。

---

# 9. 但是文学允许违反规则怎么办？

必须有：

Override。

例如：

作者：

“我要推翻旧设定。”

创建：

```yaml
Canon Change:

reason:
new direction

effective:
Chapter20 onward
```

---

类似：

代码：

```typescript
// intentional override
```

---

# 10. 最终架构应该像这样

```
              Human / LLM

                    |
                    |
              Draft Output

                    |
                    v

          Claim Extraction Layer

                    |
                    v

             Validation Engine

        +-----------+------------+

        |                        |

   Hard Rules              Soft Review

        |                        |

        +-----------+------------+

                    |

             Proposal Queue

                    |

              Commit System

                    |

             Narrative State

```

---

# 11. 一个非常重要的设计原则

我认为你这个系统应该明确：

> **LLM 不产生事实，LLM 产生候选事实。**

事实必须经过：

- 推导
- 验证
- 批准

才能成为世界状态。

---

这和软件工程非常像：

用户输入：

不是数据库。

代码提交：

不是生产环境。

LLM 输出：

也不是小说 Canon。

---

# 12. 这也是为什么你的方向比普通 AI 写作工具高级

普通：

```
Prompt
 ↓
LLM
 ↓
Text
```

你的：

```
Intent

↓

State

↓

Proposal

↓

Validation

↓

Generation

↓

Review

↓

Commit
```

本质上是：

**给生成模型增加了一套“版本控制 + 类型系统 + 测试体系”。**

而长篇小说最缺的，恰恰就是这个。

如果继续深入，下一个非常值得研究的问题其实是：

> **小说里的“类型系统（Type System）”应该怎么设计？**

因为你现在已经有了：

- Git（版本）
- Database（状态）
- CI（验证）
- Compiler（Context）

还缺一个类似 TypeScript 的东西：

让系统提前发现“这种剧情结构可能不合法”。这会是非常有意思的方向。

### User
你帮我拓展一下

### Assistant
你现在其实已经走到了一个非常有意思的抽象：

> 如果小说工程化，那么除了 Git、数据库、CI/CD，还缺什么？

软件工程里面有几个核心抽象：

|软件工程|小说工程对应|
|-|-|
|代码|正文文本|
|Git|版本管理|
|数据库|世界状态|
|编译器|Context 编译|
|测试|一致性检查|
|Type System|叙事约束|
|Runtime|阅读体验|
|Debugger|剧情分析|

你现在问的“拓展”，我觉得应该重点研究 **Narrative Type System（叙事类型系统）**，因为它可能是这个系统区别于普通 Notion/AI 写作工具的核心。

---

# 一、为什么小说需要“类型系统”？

程序里面：

```typescript
const age:number = "hello"
```

编译器提前告诉你：

错误。

因为：

类型不匹配。

---

小说也存在类似问题：

例如：

## 信息类型错误

场景：

第三人称：

> Alice 不知道 Bob 是卧底。

下一句：

> Alice 想起 Bob 五年前加入组织的真正目的。

问题：

不是剧情错误。

是：

**知识权限错误。**

---

类似：

```typescript
type Knowledge<Alice>

cannot access Secret<Bob>
```

---

所以小说需要：

## Character Knowledge Type

---

例如：

```yaml
Character:
 Alice

Knowledge:

Known:
 - Bob disappeared
 - Castle exists

Unknown:
 - Bob is spy

FalseBelief:
 - Bob betrayed her
```

---

Scene：

检查：

```text
Narrator:
Alice POV

Sentence:
Alice knows Bob is spy

ERROR:
Access denied
```

---

这可以解决：

非常常见的问题：

> 角色知道了作者才知道的信息。

---

# 二、第一个类型系统：信息类型（Information Type）

小说最大的 bug：

不是时间。

是：

**信息泄露。**

---

定义：

```text
Information
```

有生命周期：

```text
Unknown

↓

Rumor

↓

Suspected

↓

Confirmed

↓

Public
```

---

例如：

杀人犯身份：

第一章：

```yaml
State:
Unknown
```

第五章：

```yaml
Rumor
```

第十章：

```yaml
Suspected
```

第三十章：

```yaml
Confirmed
```

---

如果第二章：

直接：

“他就是凶手”

系统：

warning。

---

# 三、第二个类型系统：人物状态类型

人物不是：

属性集合。

而是：

状态机。

---

例如：

Alice：

```text
Normal

 ↓

Traumatized

 ↓

Revenge

 ↓

Forgiveness
```

---

事件：

必须合法转换。

---

例如：

当前：

```text
Trust = 0
```

突然：

```text
Alice sacrifices herself for Bob
```

可能：

需要：

Transition Missing。

---

系统提示：

> 缺少导致信任提升的事件。

---

类似：

编译器：

缺少初始化。

---

# 四、第三个类型系统：事件类型

所有剧情事件可以分类。

例如：

```yaml
EventType:

- Introduction
- Conflict
- Revelation
- Decision
- Transformation
- Resolution
```

---

然后检查：

结构。

例如：

一个故事：

连续：

20 个 Introduction。

可能：

节奏异常。

---

类似：

代码：

循环复杂度过高。

---

# 五、第四个类型系统：因果类型

小说不是事件列表。

是：

因果链。

---

错误：

```text
A发生

B发生

C发生
```

---

正确：

```text
A
 |
cause
 |
B
 |
cause
 |
C
```

---

例如：

主角突然变强。

检查：

```yaml
PowerIncrease:

requires:

Training
Artifact
Teacher
```

---

没有：

就是：

“战力膨胀”。

---

# 六、第五个类型系统：视角类型

这个非常重要。

你之前提到：

第一人称、第三人称。

---

可以定义：

```yaml
POV:

Character:
Alice

Access:

Emotion:
yes

Thought:
yes

Visual:
limited
```

---

第一人称：

```text
I saw Bob cry.
```

合法。

---

但是：

```text
I saw Bob secretly smiling behind me.
```

不合法。

除非：

有镜子。

---

---

# 七、第六个类型系统：伏笔类型

伏笔其实类似：

资源。

---

代码：

```text
malloc()

↓

free()
```

---

伏笔：

```text
Plant()

↓

Payoff()
```

---

类型：

```yaml
Foreshadow:

type:

- Object
- Information
- Character
- Theme

Status:

- planted
- developing
- resolved
```

---

检查：

Memory Leak：

```text
Plant:
Chapter1

No Payoff:
Chapter100
```

---

哈哈。

小说也有：

Memory Leak。

---

# 八、第七个类型系统：主题类型

这个更高级。

---

例如：

主题：

“自由”。

出现：

```text
Bird

Sky

Door

Flight
```

---

这些不是剧情。

但是：

形成：

语义网络。

---

可以：

```yaml
Theme:

Freedom

Motifs:

Bird
Open Door
Wind
```

---

然后：

编辑时：

提醒：

“最后三章完全没有主题回响。”

---

# 九、进一步：Narrative Compiler

如果把这些组合：

你会得到：

小说编译器。

---

输入：

Human:

```text
我想写：

Alice发现Bob背叛她
```

---

Compiler：

生成：

Scene Contract：

```yaml
Scene:

Required:

Event:
Revelation


Character:

Alice:
emotion:
shock


Knowledge:

Alice:
cannot know full truth


POV:

Alice


Threads:

Bob Secret:
advance 20%

```

---

LLM：

生成正文。

---

然后：

Compiler：

检查。

---

# 十、Debugger

软件：

Debug：

找到：

bug位置。

---

小说：

也可以：

例如：

作者问：

> 为什么第三卷很难写？

系统分析：

```text
Detected:

Main Character Motivation Weakening

Cause:

Chapter12 removed father's death event

Affected:

Chapter13-30
```

---

这就是：

剧情 Debugger。

---

# 十一、Runtime：读者体验

更疯狂一点。

软件运行：

看：

性能。

小说运行：

看：

阅读体验。

---

指标：

不是：

CPU。

而是：

---

## Suspense

悬念。

---

## Information Density

信息密度。

---

## Emotional Curve

情绪曲线。

---

例如：

```text
Chapter:

Emotion:

+3
-2
+8
```

---

发现：

连续10章低刺激。

提示：

节奏问题。

---

# 十二、最终架构可能变成：

```
                 Novel IDE

                      |

              Narrative Compiler

                      |

        +-------------+-------------+

        |                           |

 Narrative Type System       Story State Engine


        |                           |

        +-------------+-------------+

                      |

               Context Builder

                      |

                     LLM

                      |

               Draft Text

                      |

              Narrative Test Suite

                      |

                 Commit
```

---

# 十三、但是要注意一个边界

不要试图：

“把文学全部类型化”。

这是失败路线。

类型系统应该覆盖：

## 可以验证：

✅ 时间
✅ 信息
✅ 因果
✅ 状态
✅ 视角
✅ 伏笔
✅ 世界规则


不要强行验证：

❌ 美感
❌ 诗意
❌ 创新
❌ 风格


---

# 我的判断

如果这个方向继续深化，最有研究价值的不是：

“AI 写小说”。

而是：

> **Narrative Engineering（叙事工程）：为长篇叙事建立类似软件工程的可维护基础设施。**

这其实已经接近一个新的交叉方向：

- 软件工程
- 知识表示
- Agent 系统
- 计算叙事学（Computational Narratology）

作为本科毕设不需要做到完整，但你完全可以截取其中一个：

例如：

> “基于事件溯源和知识图谱的长篇小说一致性维护系统”

这已经是一个很扎实的计算机课题。你现在脑中的东西，其实已经从“AI 写小说”逐渐变成了“小说领域的软件基础设施”。这才是更有价值的方向。

### User
问题在于这些type都不是程序驱动的
我们假设llm与人工同层级，都是外部，那么是否太依赖外部了

### Assistant
你这个问题非常关键，而且实际上触碰到了**这个系统能不能成立的核心架构问题**。

你提出：

> 这些 type 都不是程序驱动的。
> 假设 LLM 与人工同层级，都是外部输入，那么是不是太依赖外部了？

答案是：

**是的，如果你的 Type System 依赖 LLM 或作者主动维护，它会失败。**

但这里有一个重要区分：

> 类型系统不是用来“创造正确小说”的，而是用来“限制和验证状态变化”。

这和编程语言的类型系统很像。

---

# 1. 一个误区：不要让 Type System 成为“文学规则”

比如：

错误设计：

```
type Hero = {
    brave: boolean
    kind: boolean
}
```

然后：

```
if hero.brave == false:
    reject()
```

这不可能。

因为文学允许：

- 胆小英雄
- 堕落英雄
- 反英雄

这种东西无法程序判断。

---

正确方向：

Type System 只管理：

**世界是否自洽。**

---

比如：

## 时间类型

程序可以知道：

```yaml
Event:
  chapter: 10

Effect:
  Alice_knows_secret=true
```

那么：

第 5 章：

```text
Alice:
"我知道秘密"
```

程序可以发现：

时间不可能。

---

这是硬约束。

---

# 2. 你的系统应该类似数据库，而不是专家系统

很多 AI 系统失败原因：

设计成：

```
AI:
告诉你应该怎么写
```

但是更可靠：

```
System:
保存事实

AI:
提出修改
```

---

类似：

数据库：

不会判断：

“这个用户是不是好人”。

但是知道：

```
user_id
balance
transaction
```

不能乱。

---

小说系统：

不要存：

```
Alice 是善良的人
```

这种。

应该存：

```
Alice
Event:
saved Bob

Event:
betrayed Bob

Event:
lied to Bob
```

---

人格：

由事件推导。

---

# 3. LLM 和人类为什么应该同层？

你这个假设其实非常正确。

因为：

LLM：

```
生成一个剧情建议
```

人类：

```
修改剧情
```

本质都是：

外部 mutation。

---

所以架构应该：

```
             External Actor

        Human       LLM Agent

              |
              |
              v

        Proposal Layer

              |
              |

        Validation Engine

              |
              |

        Canonical State
```

---

重点：

**任何人或者 AI 都不能直接修改 Canonical State。**

---

# 4. 那程序真正控制什么？

这里要重新定义。

程序不是控制：

“故事”。

程序控制：

“变化”。

---

类似 Git。

Git 不知道：

代码逻辑是不是优雅。

但是知道：

commit:

```
add file
delete file
modify file
```

是否合法。

---

小说：

程序控制：

## Entity Integrity

例如：

角色：

不能突然消失。

---

## Reference Integrity

例如：

事件引用不存在角色。

错误：

```
Event:
Alice fights Dragon

But:
Dragon entity missing
```

---

## Temporal Integrity

时间。

---

## Causal Integrity

因果。

---

## State Transition Integrity

状态变化。

---

# 5. 那 LLM 幻觉怎么办？

不要防止。

防止不了。

应该：

降低权限。

---

错误：

```
LLM:
Alice killed Bob

Database:
Bob.dead=true
```

---

正确：

```
LLM:

Proposal:
Alice killed Bob


Validator:

Check:
Is Bob alive?
Is killing allowed?


Human:

Approve


Commit
```

---

这就是：

事务系统。

---

# 6. 一个更准确的类比

你的系统不是：

```
小说编译器
```

而更像：

```
数据库 + Git + CI
```

---

LLM：

像：

程序员。

---

人：

也是：

程序员。

---

代码库：

就是：

Story State。

---

提交：

就是：

剧情修改。

---

CI：

检查：

是否破坏系统。

---

# 7. 那 Type System 到底是什么？

我觉得应该改名。

不要叫：

Narrative Type System。

容易误解。

叫：

## Narrative Constraint System

更准确。

---

它不是：

定义：

“什么是好小说”。

而是：

定义：

“什么状态变化是不合法的”。

---

例如：

允许：

```
Hero:
Coward -> Brave
```

不允许：

```
Dead Character -> Speaking
```

除非：

```
Ghost=true
```

---

# 8. 那文学部分怎么办？

交给：

Human + LLM。

但是系统提供：

上下文。

例如：

Scene Contract:

```
Must:

Alice learns truth

Must not:

Reveal killer identity


Current emotion:

Fear


Available knowledge:

Alice knows:
Bob lied

Alice doesn't know:
Bob was forced
```

---

然后：

LLM 创作。

---

# 9. 这样系统还有价值吗？

有，而且更强。

因为你的目标不是：

“替代作者”。

而是：

给作者一个：

**叙事操作系统。**

---

操作系统不告诉你：

Word 文档写什么。

但是：

提供：

- 文件系统
- 权限
- 内存管理
- 进程管理

---

你的系统：

提供：

- 世界状态
- 时间管理
- 叙事权限
- 修改影响分析

---

# 10. 最终架构应该变成

```
                 Human

                   \
                    \
                     \
                      v

                 Proposal

                      ^
                     /
                    /
                 LLM


                      |

              Validation Layer

                      |

              Story State DB

                      |

             Derived Views

     Timeline / Character / Plot / Theme
```

---

这里有一个非常重要的结论：

> **不要让 AI 帮你维护小说世界；让系统维护世界，让 AI 和人类共同修改世界。**

这就是从“AI 写作助手”升级到“叙事基础设施”。

---

所以你的担忧是对的：

如果 type 是靠人和 LLM 维护，它没有意义。

但是如果 type 是：

- 数据完整性约束
- 状态转换约束
- 权限约束
- 可验证关系

那么它和数据库 schema、类型系统、事务系统一样，是程序真正掌控的部分。

这也是这个项目从“有趣想法”走向“计算机系统设计”的关键分界线。

### User
他有哪些是必须依赖llm才能实现的功能

### Assistant
这个问题非常关键，因为它决定了你的系统边界：

> **哪些东西是软件工程可以解决的，哪些东西必须依赖 LLM 才有价值？**

如果把 LLM 拿掉，你得到的是“小说管理系统”；如果加入 LLM，你才得到“AI 小说工程系统”。

我会从架构层拆。

---

# 总原则

你的系统应该分成三层：

```
                Human / LLM
              (创造层)

                  ↓

          Narrative Intelligence Layer
          (需要 AI)

                  ↓

          Narrative Infrastructure
          (纯软件)
```

---

# 第一类：完全不需要 LLM 的部分（软件可以稳定实现）

这些应该是你的底座。

---

## 1. 世界状态管理

不需要 LLM。

例如：

```json
{
 "character": "Alice",
 "age": 18,
 "location": "Capital",
 "alive": true
}
```

数据库即可。

---

包括：

- 人物
- 地点
- 物品
- 势力
- 时间
- 关系

---

类似：

游戏服务器。

---

## 2. 时间线管理

完全程序化。

例如：

```
Chapter 1
 Day 1

Chapter 5
 Day 10
```

可以检测：

```
错误:
Day 10 后发生的事件影响 Day 5
```

---

## 3. 版本管理

完全程序。

类似 Git。

支持：

- branch
- diff
- rollback
- merge

---

例如：

版本 A：

Bob 是敌人

版本 B：

Bob 是卧底

比较：

影响：

```
Chapter 3
Chapter 8
Chapter 20
```

---

## 4. 依赖关系图

程序。

例如：

```
Alice
 |
 knows
 |
Secret X
 |
revealed in Chapter 20
```

---

删除：

Secret X

自动找到影响。

---

## 5. 规则验证

程序。

例如：

世界规则：

```
魔法不能复活死人
```

事件：

```
Bob resurrection
```

检查。

---

这些类似：

数据库 constraint。

---

# 第二类：LLM 辅助但不是必须的部分

这里是混合区。

---

# 1. 信息抽取

例如：

用户输入：

> Alice在第三章发现父亲留下的信。

系统需要变成：

```json
{
 event:"discover_letter",
 actor:"Alice",
 time:"Chapter3",
 object:"letter"
}
```

---

这个：

人工可以做。

但是 LLM 极大降低成本。

---

所以：

LLM 是：

Parser。

---

类似：

自然语言 → AST。

---

# 2. 状态更新建议

例如：

用户修改：

> Bob其实不是反派，而是假装投靠敌人。

系统需要：

提出：

```
Detected change:

Bob alignment changed

Affected:

- Chapter 4
- Chapter 10
- Chapter 30
```

---

LLM 很适合理解语义。

---

# 3. Context 生成

这是非常核心。

数据库里面有：

100万个事实。

但是 Scene 只需要：

50条。

---

问题：

哪些相关？

这个很难硬编码。

---

LLM 可以：

理解：

当前 Scene：

需要什么。

---

例如：

Scene:

Alice审问Bob。

需要：

```
Alice relationship Bob
Bob secrets
Previous conflicts
Current emotions
```

---

这就是：

Context Compiler。

---

# 第三类：必须依赖 LLM 的部分

这里才是真正 AI 的价值。

---

# 1. 从意图生成剧情方案

人说：

> 我想写一个背叛场景。

程序不知道：

什么意思。

LLM 可以：

生成：

```
Possible beats:

1.
Suspicion

2.
Evidence

3.
Confrontation

4.
Emotional break
```

---

这是创造。

程序做不了。

---

# 2. Scene 生成

最明显。

输入：

```
Scene Contract

↓

正文
```

---

程序不能写：

- 对话
- 描写
- 节奏

---

必须：

LLM 或人。

---

# 3. 风格迁移

例如：

用户：

> 写得更冷峻一点。

程序不知道：

冷峻。

LLM 可以。

---

包括：

- 文风
- 句式
- 节奏
- 修辞

---

# 4. 文学编辑

例如：

判断：

> 这里情绪转变是不是太快？

这个目前没有可靠规则。

---

LLM 可以作为：

Reviewer。

---

# 5. 伏笔设计建议

注意：

伏笔检查：

程序可以。

例如：

```
Plant exists?
Payoff exists?
```

但是：

设计：

```
这个伏笔是否巧妙？
```

需要 LLM。

---

# 6. 人物心理分析

程序知道：

```
Alice lost brother
```

但是不知道：

```
Alice为什么嘴硬？
```

---

LLM 可以辅助：

```
possible motivation:
- guilt
- fear
- denial
```

---

# 7. 创意探索

例如：

用户：

> 下一章怎么发展？

程序：

没有创造能力。

LLM：

可以提供：

```
Option A:
betrayal

Option B:
misunderstanding

Option C:
hidden enemy
```

---

# 一个比较完整的拆分表

|功能|程序|LLM|
|-|-|-|
|人物数据库|★★★★★|-|
|世界观存储|★★★★★|-|
|时间线|★★★★★|-|
|版本控制|★★★★★|-|
|影响分析|★★★★★|辅助|
|事实检查|★★★★★|辅助|
|文本解析|-|★★★★★|
|剧情理解|-|★★★★★|
|生成大纲|-|★★★★★|
|生成Scene|-|★★★★★|
|润色|-|★★★★★|
|风格模拟|-|★★★★★|
|文学评价|-|★★★|
|创新创意|-|★★★★|

---

# 最关键的设计：LLM 不应该拥有“写入权限”

这是整个系统稳定性的核心。

错误：

```
LLM
 ↓
Novel Database
```

会崩。

---

正确：

```
LLM

↓

Proposal

↓

Validator

↓

Human approve

↓

Commit
```

---

# 举个完整流程

用户：

> 第一章加入一个神秘老人。

---

## LLM：

理解：

```json
Proposal:

Add Character:
Old Man

Role:
mentor

Secret:
unknown
```

---

## 系统：

检查：

```
Character name conflict?
Timeline valid?
World rule valid?
```

---

## 用户：

确认。

---

## 系统：

commit。

---

# 最终边界

你的系统中：

**程序负责“世界”。**

**LLM负责“理解和创造”。**

非常类似：

游戏：

- 引擎负责规则
- 玩家创造玩法

或者：

软件：

- 操作系统负责资源
- 用户运行程序

---

所以真正值得做的核心不是：

“让 LLM 写更多”。

而是：

> **建立一个可靠的叙事运行环境，让不可靠的生成模型可以安全参与长篇创作。**

这其实也是为什么你的方向和普通 AI 写作工具有本质区别。你不是在做 Writer，你是在做 Narrative Runtime。

### User
总结我整个系统，我需要把它完整的给opencode

### Assistant
我把它整理成一份可以直接丢给 opencode 的系统说明稿，尽量把目标、边界、架构和工作流都说完整了。

:::writing{variant="document" id="48271"}
# 小说工程辅助系统（Narrative Harness）总设计说明

## 1. 项目目标

做一个面向长篇小说创作的软件工程辅助系统，服务对象包括真人作者和 LLM。
系统的目标不是“自动写完小说”，而是把长篇小说创作变成一个**可管理、可验证、可回滚、可分支、可调试、可扩展**的工程流程。

核心体验是：

- 用户像使用一个熟悉的 AI interface 一样和系统交互；
- 用户输入灵感、设定、大纲、同人参考、原文参考等；
- 系统把这些内容编译成结构化工程资产；
- 之后小说创作进入类似软件开发的流程：
  - 规划
  - 拆分
  - 生成
  - 校验
  - 审稿
  - 修改
  - 发布
- 所有步骤都应该能插入人工，也能插入 LLM；
- LLM 和人类作者都被视为外部不可靠输入源，权限相同；
- 系统本身必须尽量稳定、可复现、可长期维护。

---

## 2. 核心定位

这个系统不是传统意义上的 AI 写作器，也不是单纯的角色聊天工具。
它更像：

- 小说版 IDE
- 小说版 GitHub
- 小说版 CI/CD
- 小说版状态管理系统
- 小说版上下文编译器

一句话概括：

> 为长篇小说创作建立一套类似软件工程的基础设施，让人和 LLM 在同一套可靠规则下协作。

---

## 3. 设计原则

### 3.1 LLM 与人类同层级
LLM 和人类都不是“系统真相来源”，而是外部输入源。
它们都只能提交提案、补丁、草稿、建议，不能直接修改 canonical state。

### 3.2 状态由系统维护，不由模型维护
角色、世界观、时间线、关系、伏笔、剧情线程、知识边界等，必须由系统维护。
LLM 只负责提出候选内容，不负责保存事实。

### 3.3 允许人工完全替代 LLM
系统中所有依赖 LLM 的步骤，都应该可以由人工接管。
这意味着系统在没有 LLM 的情况下，也应作为小说工程管理软件可用。

### 3.4 长篇优先
系统不是为了短篇炫技，而是为了长篇、系列文、商业小说、同人长文等复杂创作场景。

### 3.5 工程化但不压死创作
系统只约束：
- 时间
- 因果
- 角色状态
- 信息边界
- 结构一致性
- 伏笔生命周期
- 版本演化

系统不强行约束：
- 修辞
- 文风
- 比喻
- 象征
- 留白
- 文学创新

这些属于生成层，由人或 LLM 自由发挥。

---

## 4. 系统想解决的问题

### 4.1 长篇创作中最常见的问题
- 人物前后不一致
- 时间线冲突
- 角色知道了不该知道的信息
- 第一章修改导致后面全崩
- 伏笔遗失或提前暴露
- 支线和主线打架
- 多视角混乱
- 明线暗线失控
- 生成文本风格不稳定
- 长上下文成本高、质量不稳

### 4.2 系统的解决方式
- 把小说拆成可管理的结构化资产
- 用事件流和版本系统管理状态变化
- 用依赖图管理修改影响
- 用上下文编译器给 LLM 或人工提供“小而稳定”的局部上下文
- 用检查器、审稿器、回滚机制、缓存机制降低错误和成本

---

## 5. 系统总体架构

### 5.1 三层结构

#### A. Narrative Infrastructure（纯软件底座）
负责：
- 项目管理
- 版本控制
- 状态存储
- 时间线管理
- 依赖图
- 缓存
- 校验
- 回滚
- 分支
- 发布

这层必须确定性、可复现、可长期运行。

#### B. Narrative Intelligence Layer（可由 LLM 或人工完成）
负责：
- 灵感理解
- 需求解析
- 大纲生成
- 场景规划
- 角色建议
- 剧情建议
- 语义分析
- 风格润色
- 质量审稿
- 伏笔建议
- 影响分析建议

这层是外部智能层，可以用 LLM，也可以人工。

#### C. Narrative Rendering Layer
负责：
- 把结构化叙事计划渲染成自然语言正文
- 把抽象结构变成可读的小说文本
- 把修改过的场景重写成最终稿

---

## 6. 核心数据模型

### 6.1 Project
一个小说项目的根对象，包含：
- 基本信息
- 类型
- 目标读者
- 风格目标
- 版本分支
- 设定集合
- 剧情集合
- 场景集合
- 草稿集合
- 审稿记录

### 6.2 Character
角色不是静态表，而是时态对象。
角色由以下部分组成：
- Identity：姓名、外貌、基础背景等静态信息
- Timeline：角色在不同故事时间点的快照
- Arc：成长路径或状态演化
- Knowledge：角色知道什么、不知道什么、误以为什么
- Relationship：与其他角色的关系变化
- Flags：活着、死亡、失忆、伪装、隐藏身份等

### 6.3 World
世界观模型，包含：
- 世界规则
- 力量体系
- 地点
- 物品
- 组织
- 历史事件
- 禁忌规则
- 信息传播规则

### 6.4 Event
事件是系统最重要的底层对象。
不要只存“结果”，要存“发生了什么”。

事件应至少包含：
- id
- story time
- revision
- participants
- preconditions
- action
- effects
- narrative purpose
- relation to threads
- relation to foreshadow
- relation to knowledge state

### 6.5 Scene
Scene 是最主要的写作与生成单位。
一个 Scene 应包含：
- scene goal
- POV
- time
- location
- participating characters
- hard constraints
- soft constraints
- required outcome
- active threads
- allowed knowledge
- disallowed knowledge
- stylistic target

### 6.6 Thread
Thread 表示跨场景的叙事线，包括：
- 主线
- 支线
- 情感线
- 伏笔线
- 悬念线
- 人物成长线
- 关系线
- 世界观揭示线

### 6.7 Motif / Theme / Foreshadow
这些不是硬状态，但必须可追踪：
- Motif：重复出现的意象或象征
- Theme：主题方向
- Foreshadow：伏笔，必须有 plant / payoff / status

### 6.8 Knowledge State
必须区分：
- 世界真相
- 角色知道什么
- 读者知道什么
- 叙述者知道什么

这对第一人称、第三人称、悬疑、反转、误导叙事非常关键。

---

## 7. 状态管理方式

### 7.1 事件溯源（Event Sourcing）
系统不直接把“当前人物状态”当最终真相，而是保存事件流。
当前状态由事件回放 + 规则计算 + 快照恢复得到。

### 7.2 快照（Snapshot）
为了性能，系统定期保存：
- 角色快照
- 世界快照
- 章节快照
- 分支快照

### 7.3 分支（Branch）
允许在修改过去设定时创建分支，而不是粗暴覆盖。
例如：
- chapter1-v1
- chapter1-v2
- main
- what-if/alice-survives

### 7.4 依赖图（Dependency Graph）
修改一个事件或章节时，系统计算受影响范围：
- 角色状态
- 伏笔
- 世界状态
- 后续场景
- 章节草稿
- 主题回响

---

## 8. 上下文编译器（Context Compiler）

系统最关键的能力之一，是把巨大状态编译成一个“小而稳定”的局部上下文，交给 LLM 或人工创作。

### 8.1 原则
不要把整个世界塞给模型。
应该只给当前 Scene 需要的最小上下文，但要足够完整。

### 8.2 输入构成
一个 Scene 的上下文包建议包含：
- 写作任务说明
- 小说类型与风格规则
- 当前 Scene 的目标
- 当前 POV
- 当前时间点
- 当前地点
- 相关角色的最新快照
- 相关世界事实
- 角色知识边界
- 前一场/前几场摘要
- 正在进行的剧情线程
- 相关伏笔状态
- 允许的表达空间
- 禁止泄露的信息
- 需要维持的主题或母题

### 8.3 输出对象
输出不是直接“全文最终稿”，而应该分层：
- Scene Plan
- Beat Sheet
- Draft
- Revision Suggestions
- Final Text

---

## 9. 写作单元设计

### 9.1 最小生成单元
建议使用 Scene 作为最小生成单元。
Beat 用于规划，Scene 用于生成，Chapter 用于审核与发布。

### 9.2 推荐生产链路
1. 用户或 AI 定义 Scene Intent
2. 系统生成 Scene Contract
3. 生成 Beat Sheet
4. 生成 Draft
5. 运行一致性检查
6. 运行风格与人物声音检查
7. 人工或 AI 审稿
8. 应用补丁
9. 保存版本
10. 发布/继续迭代

---

## 10. 必须依赖 LLM 的能力

以下功能原则上必须依赖 LLM，或者至少需要 LLM 级别的语义理解：

- 从自然语言灵感中提取可结构化的叙事意图
- 将粗糙想法转换成可执行的 Scene Plan
- 设计剧情推进方式
- 生成正文
- 进行文风迁移
- 处理隐喻、修辞、留白、气氛
- 进行语义级审稿
- 对复杂上下文进行语义理解
- 给出可能的冲突/修改建议
- 创造性的细节填充
- 复杂的人物心理推断
- 对同人原作风格和世界观进行映射

但这些功能都只能以“提案”形式进入系统，不能直接写入 canonical state。

---

## 11. 不必须依赖 LLM 的能力

以下功能应该尽量由程序完成：
- 世界状态存储
- 时间线管理
- 版本控制
- 依赖分析
- 事件回放
- 快照恢复
- 规则校验
- 知识边界检查
- 伏笔状态跟踪
- 分支管理
- 缓存管理
- 回滚
- Diff
- Merge
- 审批流
- 发布记录
- 影响范围分析
- 结构化导出

---

## 12. 错误处理与可靠性策略

### 12.1 把 LLM 和人类都视为不可靠输入
任何来自外部的内容，都需要经过：
- 解析
- 校验
- 影响分析
- 审核
- 提交

### 12.2 LLM 不直接改状态
LLM 输出：
- 草稿
- 建议
- 候选事件
- 候选补丁
- 候选设定

系统决定是否接受。

### 12.3 人类修改也要走同一流程
人工改剧情、改设定、插入段落，也要：
- 影响分析
- 校验
- 版本化
- 可能回滚

### 12.4 幻觉处理
LLM 幻觉不视为错误终点，而视为：
- 候选事实
- 候选设定
- 候选补丁

进入验证流后决定是否接受。

---

## 13. 修辞、明暗线、伏笔、隐喻的处理方式

### 13.1 修辞
修辞不进入硬状态层，不强制结构化成死规则。
修辞属于生成层，由人或 LLM 自由创作。

### 13.2 明暗线
作为 Thread 管理，但表达方式自由。
系统管理的是“这条线存在、进展多少、何时揭示”，不是具体句子怎么写。

### 13.3 伏笔
伏笔应具备 plant / payoff / status / importance / reveal level。
系统负责追踪伏笔是否埋下、是否回收、是否提前泄露。

### 13.4 隐喻 / 母题
作为 Motif / Theme 管理，用于提醒长期回响。
系统不限制写法，但可以提示出现频率、回响节点、重复模式。

---

## 14. 缓存与成本控制

### 14.1 需要缓存的内容
- Context Package
- Character Snapshot
- Chapter Summary
- World Snapshot
- Embedding
- Reviewer Results
- Prompt 前缀
- 检查结果
- 影响分析结果

### 14.2 缓存原则
只缓存中间产物，不缓存最终文本为主。
只要底层状态没有变化，就尽量复用上下文和审稿结果。

### 14.3 增量更新
修改某个章节或事件后，只重新计算受影响的局部，而不是全书重算。

---

## 15. 交互界面（Interface）要求

### 15.1 目标体验
用户像在使用一个熟悉的 AI interface 一样工作，但背后其实是小说工程系统。

### 15.2 主要界面模块
- Project dashboard
- Characters panel
- World panel
- Timeline panel
- Thread panel
- Scene editor
- Draft editor
- Review panel
- Diff / rollback panel
- Branch manager
- Context inspector
- Impact analyzer
- Cache inspector

### 15.3 交互逻辑
- 用户可以直接输入灵感
- 用户可以修改任意章节
- 用户可以接管 LLM 的任意一步
- 用户可以查看系统给 LLM 的上下文
- 用户可以查看系统为什么拒绝某个补丁
- 用户可以强制覆盖，但要有明确记录
- 用户可以切换 branch
- 用户可以回滚到任意版本

---

## 16. 面向真人作者的可行性

即使完全没有 LLM，这个系统也应该可用。
在纯人工模式下，它就是一个面向长篇小说的：

- 项目管理器
- 状态管理器
- 版本管理器
- 结构检查器
- 依赖分析器
- 场景组织器
- 创作协作平台

这意味着它不是“AI 包装壳”，而是一个真正的小说工程基础设施。

---

## 17. 面向 LLM 的工作方式

### 17.1 LLM 在系统里的角色
LLM 是：
- 规划者
- 草稿生成器
- 改写器
- 审稿器
- 语义解析器
- 语义建议器

但不是：
- 真相来源
- 状态维护者
- Canon 决策者
- 直接写库的人

### 17.2 LLM 的输入输出模式
输入：结构化上下文包
输出：结构化提案 + 正文草稿 + 解释性建议

建议所有输出都尽量带：
- claims
- assumptions
- confidence
- affected items
- suggested edits

---

## 18. 目标上限与边界

### 18.1 能明显提升的
- 长篇一致性
- 连载维护
- 修改控制
- 世界观管理
- 角色管理
- 伏笔管理
- 多线剧情管理
- 商业小说草稿生成效率
- 人工/AI 协作效率
- 低成本迭代

### 18.2 很难完全替代的
- 真正突破性的文学创新
- 诗性极强的独特风格
- 高级隐喻的原创性
- 人生经验驱动的深层人物灵魂
- 彻底打破范式的新文学形式

---

## 19. 推荐的 MVP 范围

第一版建议只做以下内容：

### 核心功能
- 项目管理
- 人物管理
- 世界观管理
- 时间线管理
- Scene 管理
- 事件管理
- 版本管理
- Diff / rollback
- 上下文编译器
- 基础一致性检查
- LLM 提案式接入
- 人工接管能力

### Scene 结构最小集合
- Goal
- POV
- Constraints
- Outcome
- Active Threads
- Knowledge Boundary
- Relevant Character Snapshots

### 一致性检查
- 时间线冲突
- 角色状态冲突
- 角色知识冲突
- 世界规则冲突
- 伏笔未回收
- 视角泄露
- 提前揭示
- 角色声音严重漂移

---

## 20. 未来扩展方向

- Narrative plugin system
- 同人模式 / 原作 branch mode
- 多人协作模式
- Writer’s room 模式
- 章节发布与读者反馈分析
- 风格模板库
- 伏笔仪表盘
- 情绪曲线图
- 叙事热力图
- 自动修复建议
- 叙事类型系统
- 剧情 Debugger
- 多模型协作
- 本地模型接入
- 云模型接入
- 手动/自动混合工作流

---

## 21. 一句话总结

这是一个为长篇小说创作者构建的“叙事工程系统”：

- 让人和 LLM 在同一套可靠规则下协作；
- 让小说变成可管理的工程对象；
- 让写作像开发一样可分支、可回滚、可审查、可缓存、可调试；
- 让 LLM 负责创造，让系统负责稳定。
:::

如果你愿意，我可以继续把这份说明整理成更适合直接喂给 opencode 的“任务拆解版”，也就是按模块列出它应该先实现什么、后实现什么。

### User
你没把 plugin 写进去

### Assistant
你指出得对，**Plugin 系统其实是这个架构里非常重要的一环**，而且它不是普通的“扩展功能”，它解决的是你前面一直强调的问题：

> 小说类型非常多样，现代小说技法不断变化，系统不应该把所有叙事知识硬编码进去。

所以 Plugin 应该是整个系统的**可扩展叙事能力层**。

我补充一个完整章节，可以直接加入前面的设计文档。

:::writing{variant="document" id="59381"}
# 22. Narrative Plugin System（叙事插件系统）

## 22.1 为什么需要 Plugin

小说创作不存在唯一标准。

不同类型小说具有不同结构：

- 推理小说：
  - 线索管理
  - 诡计设计
  - 真相揭示顺序
  - 读者误导

- 恋爱小说：
  - 情感阶段
  - 关系变化
  - 冲突升级
  - 情绪回收

- 玄幻小说：
  - 境界体系
  - 力量成长
  - 世界等级
  - 战力一致性

- 科幻小说：
  - 科技设定
  - 世界规则
  - 假设推演

- 同人小说：
  - 原作 Canon
  - 角色一致性
  - 世界观兼容

- 群像小说：
  - 多角色视角
  - 多线同步
  - 出场管理

因此系统不能把所有规则写死。

核心系统只提供：

- 状态管理
- 事件系统
- 版本系统
- 验证系统
- Context 编译系统

具体文学能力通过 Plugin 扩展。

---

# 22.2 Plugin 的定位

Plugin 不是简单工具。

它是一组：

> 针对某类叙事问题的规则、数据模型、验证器、Prompt、Agent 和 UI 扩展。

---

Plugin 可以：

1. 增加新的数据结构
2. 增加新的检查规则
3. 增加新的 Context 编译逻辑
4. 增加新的 LLM Agent
5. 增加新的工作流
6. 增加新的 UI 面板

---

# 22.3 Plugin 类型

## A. Genre Plugin（类型插件）

用于支持不同小说类型。

例如：

## Mystery Plugin

新增：

### 数据结构

```yaml
Clue:

id:
clue_001

importance:
major

introduced:
chapter3

known_by:
reader

truth:
hidden

payoff:
chapter40
```

---

### Validator

检查：

- 真相是否提前泄露
- 线索是否公平
- 推理链是否成立


---

## Romance Plugin

新增：

Relationship State:

```yaml
Alice-Bob:

stranger

↓

interest

↓

trust

↓

conflict

↓

reconciliation

```

检查：

- 感情变化是否跳跃
- 冲突是否有原因
- 情感线是否断裂


---

## Fantasy Plugin

新增：

Power System:

```yaml
Level:

1:
common

2:
advanced

3:
master
```

检查：

- 战力越级
- 能力冲突
- 世界规则违反


---

# 22.4 Technique Plugin（写作技法插件）

用于支持现代文学技法。

例如：

## Multiple POV Plugin

管理：

- 第一人称
- 第三人称
- 多角色视角


新增：

Knowledge Boundary。

检查：

当前 POV 是否知道：

- 不该知道的信息
- 其他角色内心


---

## Nonlinear Narrative Plugin

支持：

- 倒叙
- 插叙
- 多时间线


新增：

Narrative Time。

区分：

```
Story Time

和

Narration Time
```

例如：

第10章：

讲述过去第3年的事件。

---

## Foreshadow Plugin

管理：

伏笔生命周期：

```
Plant

↓

Develop

↓

Mislead

↓

Reveal

↓

Payoff
```

检查：

- 遗漏伏笔
- 过早揭示
- 重复伏笔

---

## Character Arc Plugin

管理：

人物成长：

例如：

```
Belief

↓

Conflict

↓

Crisis

↓

Transformation

↓

New Belief
```

检查：

人物变化是否有事件支撑。

---

# 22.5 AI Agent Plugin

Plugin 可以注册新的 AI Agent。

例如：

## Plot Planner Agent

输入：

Scene Contract

输出：

Beat Sheet。


---

## Literary Editor Agent

负责：

- 节奏
- 描写
- 文风


---

## Continuity Agent

负责：

发现：

- 时间错误
- 人物错误
- 世界错误


---

## Critic Agent

模拟：

编辑、读者反馈。

---

# 22.6 Validator Plugin

插件可以增加新的验证规则。

接口类似：

```typescript
interface NarrativeValidator {

  name:string

  check(
    state:NarrativeState,
    change:Proposal
  ):ValidationResult

}
```

---

例如：

Mystery Plugin：

```typescript
checkRevealOrder()
```

Fantasy Plugin：

```typescript
checkPowerConsistency()
```

POV Plugin：

```typescript
checkKnowledgeLeak()
```

---

# 22.7 Context Compiler Plugin

不同类型小说，需要不同 Context。

例如：

普通 Scene:

输入：

```
Character
Location
Timeline
Thread
```

---

Mystery Scene:

额外加入：

```
Known clues
Hidden clues
Reader suspicion
Detective hypothesis
```

---

Romance Scene:

额外加入：

```
Relationship history
Emotional state
Unspoken feelings
```

---

因此：

Context Compiler 应支持插件扩展。

---

# 22.8 Prompt Plugin

LLM Prompt 不应该硬编码。

Plugin 可以提供：

```yaml
PromptTemplate:

scene_writer:

system:
"You are writing a mystery scene..."

requirements:

- preserve clue secrecy
- maintain suspense

```

---

# 22.9 Plugin Manifest

示例：

```json
{
"name":"mystery-plugin",

"version":"1.0",

"provides":[

 "ClueSystem",

 "MysteryValidator",

 "DetectiveAgent",

 "MysteryContextCompiler"

],

"dependencies":[

 "core-story-engine"

]

}
```

---

# 22.10 Plugin 与 Canonical Core 的边界

非常重要：

Plugin 不应该直接修改核心状态。

错误：

```
Plugin

↓

Database
```

---

正确：

```
Plugin

↓

Proposal

↓

Core Validator

↓

Commit
```

---

插件只能：

- 提供能力
- 提供规则
- 提供建议

核心系统负责：

- 状态
- 权限
- 版本

---

# 22.11 用户自定义 Plugin

高级目标：

用户可以创建自己的叙事插件。

例如：

一个作者长期写：

“克苏鲁小说”。

他可以创建：

Cthulhu Plugin:

增加：

- SAN 值
- 禁忌知识
- 疯狂程度
- 不可理解事件


---

另一个作者：

创建：

宫斗 Plugin:

增加：

- 宫廷关系
- 阵营
- 权力变化


---

# 22.12 Plugin 的意义

Plugin 解决三个核心问题：

## 1. 防止过度抽象

核心系统不需要理解所有文学。

---

## 2. 支持未来演化

新的小说理论、新的创作方法，可以作为插件加入。

---

## 3. 支持商业化

未来可以形成：

Narrative Plugin Marketplace。

例如：

- 推理小说套件
- 网文爽文套件
- 言情套件
- 世界观构建套件
- 同人创作套件

---

# 22.13 最终架构

```
                User / LLM

                    |

             Plugin Layer

       +------------+------------+

       |            |            |

   Genre       Technique     Agent


                    |

          Narrative Core Engine


       +------------+------------+

       |            |            |

    State       Version       Validator


                    |

             Story Database

```

---

最终目标：

Core 提供“小说操作系统”。

Plugin 提供“不同小说类型和创作方法”。

LLM 提供“智能能力”。

Human 提供“创造和审美”。

三者组合形成可持续扩展的叙事工程平台。
:::

---

另外我觉得这里还有一个很重要的推论：

**Plugin 可能比 LLM 本身更具有长期价值。**

因为未来模型会变化：

GPT-5、Claude、Gemini、国产模型都会换。

但是：

“推理小说插件”
“人物成长插件”
“多视角插件”

这些属于领域资产，可以长期积累。

这和软件工程里的：

- Linux Kernel + 用户空间
- VSCode + Extension
- Unreal Engine + Plugin

是同一个方向。你这个系统如果继续做，Plugin 架构应该从第一天就设计进去。

### User
plugin之间是否兼容

### Assistant
这个问题非常关键，因为**如果 Plugin 之间不能组合，你最后得到的是一堆孤岛功能；如果完全允许自由组合，又会陷入规则冲突地狱。**

这其实类似软件工程里的：

- npm package dependency
- 编译器插件
- IDE extension
- Kubernetes Operator
- 游戏引擎 Mod

小说系统也需要一个**Plugin Compatibility System（插件兼容系统）**。

---

# 1. 首先：不是所有 Plugin 都应该互相兼容

举几个例子。

---

## 例子 1：推理 + 多 POV

可以。

组合：

```
Mystery Plugin
+
Multiple POV Plugin
```

效果：

支持：

- 多角色视角
- 线索隔离
- 信息差控制

---

## 例子 2：恋爱 + 群像

可以。

```
Romance Plugin
+
Multi Character Plugin
```

支持：

复杂关系网络。

---

## 例子 3：第一人称 + 全知叙事

冲突。

```
First Person Plugin
+
Omniscient Narrator Plugin
```

因为：

第一人称限制：

> 我只能知道我的信息。

全知：

> 可以知道所有人的内心。

---

## 例子 4：硬科幻 + 魔法体系

不一定冲突。

取决于：

World Rule Plugin。

可以：

```
Hard Sci-Fi
+
Fantasy
```

但是需要：

解释层。

例如：

魔法其实是高维科技。

---

所以：

Plugin 不是简单：

```
A + B = OK
```

而需要：

**能力声明 + 冲突检测。**

---

# 2. Plugin 应该声明自己的能力（Capability）

类似：

package.json。

例如：

```json
{
"name":"mystery-plugin",

"provides":[
  "ClueManagement",
  "RevealControl",
  "SuspenseAnalysis"
],

"requires":[
  "EventSystem",
  "KnowledgeSystem"
],

"conflicts":[
  "NoMysteryMode"
]
}
```

---

另一个：

```json
{
"name":"first-person-plugin",

"provides":[
  "POVControl"
],

"constraints":[
 {
   "KnowledgeAccess":"Limited"
 }
]
}
```

---

系统启动时：

分析：

```
Installed Plugins

↓

Dependency Graph

↓

Compatibility Check

```

---

# 3. Plugin 应该分层

不要所有 Plugin 平级。

建议：

```
                Application Plugins

          Genre / Technique / AI


                    ↓


              Narrative Framework


                    ↓


              Core Engine
```

---

## Core Layer

绝对稳定：

例如：

```
Entity
Event
State
Timeline
Version
Proposal
Validator
```

---

不能被 Plugin 修改。

---

## Framework Layer

提供通用能力：

例如：

```
Knowledge System
Relationship System
Theme System
```

---

## Plugin Layer

具体扩展：

```
Mystery
Romance
Fantasy
Horror
```

---

# 4. Plugin 之间不要直接依赖

错误：

```
Mystery Plugin
        |
        ↓
Romance Plugin
```

为什么？

以后：

Fantasy + Mystery + Romance

怎么办？

依赖爆炸。

---

正确：

通过：

## Shared Concepts

通信。

---

例如：

Mystery 不关心 Romance。

它只知道：

```
Relationship Change Event
```

---

Romance 产生：

```yaml
Event:

type:
relationship_change

from:
trust

to:
betrayal
```

---

Mystery：

看到：

```yaml
Event:
relationship_change
```

然后：

判断：

是否影响嫌疑。

---

松耦合。

---

# 5. 需要一个 Plugin Event Bus

类似前端事件系统。

例如：

核心产生：

```
CharacterKilled
```

---

所有 Plugin 收到：

---

Death Plugin：

处理：

```
remove alive state
```

---

Mystery Plugin：

处理：

```
new clue?
```

---

Romance Plugin：

处理：

```
relationship impact
```

---

Fantasy Plugin：

处理：

```
revival possible?
```

---

架构：

```
              Core Event Bus

                    |

    +---------------+--------------+

    |               |              |

 Mystery        Romance       Fantasy

```

---

# 6. 冲突如何解决？

需要：

Conflict Resolution。

---

## 第一层：静态检测

安装时：

例如：

发现：

```
First Person

requires:
Limited Knowledge


Omniscient

requires:
Unlimited Knowledge
```

冲突。

---

提示：

```
Cannot enable together
```

---

## 第二层：运行时检测

例如：

用户：

安装：

Mystery Plugin

然后：

开启：

AI 自动解释真相。

---

运行：

发现：

Reveal Level:

100%

但是：

Current Chapter:

10%

---

产生：

Warning。

---

# 7. Plugin 需要优先级

有时候不是冲突。

是：

谁负责。

---

例如：

生成 Scene。

有：

Fantasy Plugin

和

Horror Plugin。

都想控制氛围。

---

需要：

Priority。

---

例如：

```yaml
plugins:

Fantasy:
 priority:50

Horror:
 priority:80
```

---

Horror 覆盖：

Atmosphere。

---

类似 CSS cascade。

---

# 8. 更高级：Plugin 可以声明“关注领域”

类似 AI Agent。

例如：

```yaml
Mystery:

observes:

- Knowledge
- Event
- Timeline


Romance:

observes:

- Relationship
- Emotion


Fantasy:

observes:

- WorldRule
- Ability

```

---

这样：

系统知道：

谁应该被唤醒。

---

# 9. Plugin Compatibility Matrix

可以类似：

|Plugin|Mystery|Romance|Fantasy|POV|
|-|-|-|-|-|
|Mystery|-|✅|✅|✅|
|Romance|✅|-|✅|✅|
|Fantasy|✅|✅|-|✅|
|First Person|✅|✅|⚠️|❌|
|Omniscient|✅|✅|✅|❌|

---

但这个不能人工维护。

应该：

Plugin 自己声明。

---

# 10. 一个更深的问题：Plugin 会不会改变小说本体？

这里必须限制。

Plugin 不能：

```
修改 Canon
```

只能：

```
提供解释视角
```

---

例如：

Romance Plugin：

不能：

强制：

Alice 爱 Bob。

只能：

提供：

```
Relationship Analyzer
```

---

Mystery Plugin：

不能：

强制：

必须有凶手。

只能：

提供：

```
Clue Validation
```

---

# 11. 最终 Plugin Architecture

比较成熟应该是：

```
                         User

                          |

                    Plugin Manager

                          |

              Compatibility Resolver

                          |

                    Event Bus

                          |

      +-------------------+------------------+

      |                   |                  |

 Genre Plugins     Technique Plugins    AI Plugins


      |                   |                  |

      +-------------------+------------------+

                          |

              Narrative Core Engine


                          |

                    Story State

```

---

# 12. 最终判断

你的系统如果想长期发展：

Plugin 不是“可选功能”。

它实际上是解决：

> 小说世界无限复杂，而核心系统必须稳定。

的唯一方式。

核心只需要知道：

```
Entity
Event
State
Constraint
Proposal
```

剩下：

- 推理
- 言情
- 玄幻
- 科幻
- 恐怖
- 多视角
- 非线性叙事
- 同人 Canon

全部作为插件。

---

而且这里有一个非常有趣的方向：

未来甚至可以让 **LLM 自动生成 Plugin**：

用户：

> 我要写克苏鲁+宫斗+赛博朋克

系统：

分析需求：

生成：

```
Cthulhu Plugin
+
Palace Politics Plugin
+
Cyberpunk World Plugin
```

然后自动组合。

这会非常接近“小说领域的 Unreal Engine”。你现在这个架构已经开始接近一个真正的平台设计了。

### User
怎么变成event了，他不是静态的么

### Assistant
你这个质疑非常正确，这里其实暴露了一个**建模层级混淆的问题**。

我前面说 Plugin 通过 Event Bus 通信时，举：

```
CharacterKilled
RelationshipChange
```

这些是 **运行时事件（Runtime Event）**。

但是小说系统里面，我们必须区分：

1. **静态定义（Definition）**
2. **动态事实（State）**
3. **发生过程（Event）**
4. **推导结果（Derived State）**

如果混在一起，系统一定会乱。

---

# 1. 先重新定义小说里的对象

假设：

> Alice 和 Bob 是朋友。

这句话到底是什么？

它不是 Event。

它是一个：

## Relationship State（关系状态）

例如：

```json
{
  "from": "Alice",
  "to": "Bob",
  "type": "friend",
  "trust": 80
}
```

---

但是：

为什么他们是朋友？

需要事件。

例如：

```yaml
Event:

id:
e001

time:
Chapter 2

type:
help


actor:
Alice


target:
Bob


effect:
relationship.trust +20
```

---

所以：

关系不是事件。

关系是：

**事件累计后的状态。**

---

# 2. 正确模型应该是

类似游戏引擎：

```
Event

  ↓

State Transition

  ↓

New State
```

---

例如：

初始：

```yaml
Relationship:

Alice-Bob:

stranger
```

发生：

```yaml
Event:

Alice saves Bob
```

规则：

```typescript
if event.type=="save":
    trust +=20
```

得到：

```yaml
Relationship:

Alice-Bob:

ally
```

---

所以：

Event 是原因。

State 是结果。

---

# 3. 为什么小说系统需要 Event？

因为长篇小说不是静态数据库。

它是：

时间演化系统。

---

如果你只存：

```json
{
Alice:
{
 relationship:
  Bob:"friend"
}
}
```

你不知道：

- 什么时候成为朋友？
- 为什么成为朋友？
- 修改第一章会不会影响？
- 能不能回滚？

---

例如：

第10章：

Bob 背叛 Alice。

如果只存最终状态：

```text
Alice:
hate Bob
```

你丢失了：

变化过程。

---

所以需要：

Event Log。

---

# 4. 那 Plugin 之间怎么通信？

这里需要更精确。

不是：

“所有东西都是 Event”。

而是：

核心有：

## Domain Event（领域事件）

---

例如：

Core：

```typescript
interface StoryEvent {

id:string

type:string

timestamp:StoryTime

payload:any

}
```

---

事件类型：

```
CharacterCreated

CharacterDied

RelationshipChanged

SecretRevealed

LocationChanged

KnowledgeUpdated
```

---

注意：

这里的 Event 是：

“系统状态发生变化的通知”。

---

不是：

小说里的剧情事件。

---

两个概念名字容易冲突。

建议分开：

---

## A. Narrative Event（叙事事件）

小说里面发生的事情：

例如：

> Alice 杀死 Dragon

---

## B. System Event（系统事件）

软件内部消息：

例如：

```text
NarrativeEventCreated
```

---

不要混。

---

# 5. Plugin 应该监听什么？

举例：

## Mystery Plugin

关心：

```text
SecretRevealed
KnowledgeChanged
```

不是：

所有事件。

---

## Romance Plugin

关心：

```text
RelationshipChanged
EmotionChanged
```

---

## Fantasy Plugin

关心：

```text
AbilityUsed
PowerChanged
```

---

---

# 6. 那静态元素在哪里？

你的直觉：

> 角色、世界观、技法不是静态的吗？

对。

它们应该是：

## Schema / Definition

---

例如：

角色定义：

```yaml
CharacterDefinition:

id:
alice


traits:

brave
curious


initial_state:

age:18

```

---

世界规则：

```yaml
WorldRule:

Magic:

requires:
mana
```

---

Plugin：

主要扩展：

这些静态 schema。

---

例如：

Fantasy Plugin：

增加：

```yaml
Character:

mana

skill

level

```

---

Mystery Plugin：

增加：

```yaml
Clue

Suspect

Evidence
```

---

# 7. 所以正确架构应该是

```
                 Plugin

                    |
                    |

          Extend Schema

                    |

             Static Model


                    +

             Event System


                    |

          State Transition


                    |

             Current State

```

---

# 8. 一个完整例子

用户安装：

Romance Plugin。

它增加：

静态字段：

```yaml
Relationship:

trust
intimacy
conflict
```

---

故事开始：

```yaml
Alice-Bob:

trust:0
```

---

Scene：

Alice救Bob。

生成：

Narrative Event:

```yaml
Event:

type:
save_life

actor:
Alice

target:
Bob
```

---

Romance Plugin 有规则：

```typescript
on(save_life){

relationship.trust +=30

}
```

---

状态变：

```yaml
Alice-Bob:

trust:30
```

---

以后：

AI 写 Scene 时：

Context Compiler 提供：

```
Alice currently trusts Bob
```

---

# 9. 你的问题其实指出了一个重要设计原则

不要：

> 用 Event 表示一切。

这是很多 Event Sourcing 系统容易犯的错。

应该：

## Static Knowledge

描述：

“是什么”

---

## Event

描述：

“发生了什么”

---

## State

描述：

“现在是什么”

---

## Rule

描述：

“发生后如何变化”

---

四者分离：

```
Definition
     |
     |
 Event ----> Rule
     |
     |
     v
 State
```

---

# 10. 回到 Plugin

所以 Plugin 的职责应该改成：

不是：

“监听所有 Event 然后改小说”。

而是：

Plugin 提供：

1. 新的 Schema

例如：

```text
Clue
Relationship
PowerSystem
```

2. 新的 State Transition Rule

例如：

```text
save_life -> trust +20
```

3. 新的 Validator

例如：

```text
secret cannot reveal early
```

4. 新的 Context Provider

例如：

```text
provide current suspicion level
```

---

你刚才这个问题非常重要，因为它实际上把架构从“AI Agent 玩具”拉回到了真正的软件建模。

如果这个项目继续做，**Event / State / Definition / Rule 四者分离会是核心架构原则。**

### User
那就继续总结软件文档

### Assistant
我把前面的文档继续补充，并修正之前 Plugin/Event 部分的建模问题。

这版重点加入：

- Definition / State / Event / Rule 四层模型
- Plugin 架构的正确定位
- Schema 扩展机制
- Domain Event 与 Narrative Event 分离
- Rule Engine
- 数据一致性边界

可以直接追加到原设计文档。

:::writing{variant="document" id="73194"}
# 23. 核心领域模型设计（Domain Model）

## 23.1 设计原则

小说工程系统必须严格区分：

1. 静态定义（Definition）
2. 当前状态（State）
3. 发生事件（Event）
4. 状态变化规则（Rule）

不能将所有信息都作为 Event，也不能直接存储最终状态。

---

## 23.2 四层模型

整体关系：

```
Definition

    ↓

Event

    ↓

Rule

    ↓

State
```

---

# 24. Definition（静态定义层）

Definition 描述：

“这个东西是什么”。

它不会随着剧情自动变化。

例如：

- 角色基础设定
- 世界规则
- 地点定义
- 物品定义
- 力量体系定义
- 组织定义
- 类型规则

---

## 24.1 Character Definition

例如：

```yaml
CharacterDefinition:

id:
alice


name:
Alice


appearance:

  hair:
    black


traits:

  - curious
  - stubborn


background:

  born:
    village_A

```

---

注意：

这里不存：

Alice 当前是否信任 Bob。

因为那属于 State。

---

## 24.2 World Definition

例如：

```yaml
WorldDefinition:

magic:
