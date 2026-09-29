<p align="center">
  <img src="docs/assets/readme/banner.svg" alt="dsh-live2d-widget —— DeepSeek Harness 的 Live2D 桌宠插件" width="760">
</p>

<p align="center">
  <strong>简体中文</strong> | <a href="README.md">English</a>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-263146?style=flat-square"></a>
  <img alt="DSH plugin" src="https://img.shields.io/badge/DeepSeek%20Harness-plugin-4b6fff?style=flat-square">
  <img alt="Live2D" src="https://img.shields.io/badge/Live2D-Cubism%202%20%7C%203%20%7C%204%20%7C%205-7da1de?style=flat-square">
  <img alt="Bundled characters" src="https://img.shields.io/badge/内置角色-4-ff9ec4?style=flat-square">
  <img alt="Runtime dependencies" src="https://img.shields.io/badge/运行时依赖-0-brightgreen?style=flat-square">
  <img alt="Node" src="https://img.shields.io/badge/Node-%E2%89%A520-339933?style=flat-square&logo=node.js&logoColor=white">
  <img alt="Platform" src="https://img.shields.io/badge/平台-Windows%20%7C%20macOS%20%7C%20Linux-6b7f99?style=flat-square">
</p>

# dsh-live2d-widget

> 给 DeepSeek Harness Web 界面加一只 Live2D 桌宠：打开 DSH 就能看到可爱的二次元角色站在聊天界面角落。
> 内置 4 个角色可自由切换，点她会弹出聊天气泡说符合人设的台词（台词可自己改），
> 也支持随时导入自己的模型。零运行时依赖，纯插件挂载 —— 安装即启用，卸载不留痕。

## 功能亮点

- **可爱的内置角色** — 纱雾、雷姆、伊斯特、缇娅，覆盖 Cubism 2 与 Cubism 4 两代运行时。
- **点击说话** — 点模型弹出一句符合角色人设的台词，气泡带角色名；**每个角色的台词都能自己改**（一行一句，存到本地）。
- **拖动摆位** — 按住模型直接拖到屏幕任意位置，松手即记住，重启后还在。
- **自由切换** — 面板点一下即换模型；每个模型各自记住自己的适配、位置与台词。
- **导入自己的模型** — 支持 `.zip`、整个模型文件夹、或直接填本机目录路径；**按内容识别入口文件**，所以 `model.json`、`rem.json`、自定义文件名都能认出来。
- **可控的大小** — 「大小」调的是画布，模型等比放大而**永远不会被裁掉**；「适配」单独控制模型在画布里的占比。
- **精确输入** — 每个数值都同时有滑块和输入框：可以拖，也可以直接敲数字，还能按住数字左右拖动微调。
- **不打扰办事** — 默认只占左下角，可隐藏（`Ctrl+Shift+L`），可穿透点击聊天界面。
- **零运行时依赖** — Live2D 运行时随包发布（单个 JS 文件），不联网、不拉 CDN；解压也用自带的零依赖实现。
- **不污染 DSH** — 整只挂件活在 Shadow DOM 里，样式与 DSH 和其他插件互不影响。

## 界面预览

<p align="center">
  <img src="docs/panel.png" alt="dsh-live2d-widget 控制面板：模型列表、大小/适配/位置/透明度滑块与输入框、点击台词与导入区块，以及雷姆的聊天气泡。" width="560">
</p>

## 快速开始

前置条件：已安装 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh` 命令可用）
与 **Node.js `^22.19 || >=24`**（与 DSH 自身要求一致）。

三种安装方式，任选一种：

```powershell
# ① 从 GitHub 安装（推荐：装完即有 4 个内置角色）
dsh plugin --profile web add github:xieluyang912/dsh-live2d-widget

# ③ 本地目录安装（开发用，pnpm 会建 junction，改代码即生效）
dsh plugin --profile web add link:D:/Plugins/dsh-live2d-widget

# 卸载
dsh plugin --profile web remove dsh-live2d-widget
```

`dsh plugin` 是 pnpm 的透传（`--profile web` 之后的参数原样交给 pnpm），
所以 pnpm 支持的写法（`github:`、`git+https:`、npm 包名、`link:`、tarball）都能用。

安装命令会自动把插件写进 `%USERPROFILE%\.dsh\profiles\web\package.json` 的
`dsh.profile.bundles`，**不需要手工改 profile patch**。

> **从 git / npm 安装时不需要编译**：本插件是纯 JavaScript，没有构建步骤，
> 也没有 `install` / `prepare` 生命周期脚本，所以不会被 pnpm 的
> `ERR_PNPM_IGNORED_BUILDS` 拦住，装完即可用。

> **改完插件要重载才生效 —— 两半的加载方式不一样。**
>
> - **浏览器那半**（`assets/live2d-widget.js`、`assets/vendor`）**每次请求都从磁盘重读**，刷新页面即可。
> - **Host 那半**（`lib/index.js`、内置模型清单与模型文件）**启动时读进进程内存**，必须重启 `dsh web`。
>   DSH 在 agent 运行期间会拒绝重载插件（插件市场日志写的是 `refused while agents are running`），
>   所以要等当前会话结束或手动重启。
>
> 判断自己在看哪一版：面板里出现了「大小 / 适配 / 点击台词」但模型列表还是旧的，
> 就是**浏览器半边已更新、host 半边还是旧的** —— 重启一下就好。

## 用法

打开 DSH 后左下角出现角色，右上角有个圆形 **L2D** 按钮，点它展开控制面板。

| 区块 | 能做什么 |
| --- | --- |
| **模型** | 点任意一项立即切换；「导入」标记的是你自己导入的模型，右侧 `×` 可删除 |
| **大小** | 整体大小（0.4× ~ 2.2×）。调的是画布，模型跟着等比放大，**永远不会被裁掉** |
| **适配** | 模型在画布里的占比（0.1 ~ 3.0）。主要给导入的模型微调用；内置角色已标定好，保持 1 即可 |
| **左右 / 上下** | 模型在画布内的位置微调（−2 ~ 2） |
| **透明** | 整体透明度（15 ~ 100） |
| **左右翻转 / 换边** | 镜像、在左下角和右下角之间切换 |
| **随机动作 / 随机表情** | 手动逗一下模型（模型没有动作或表情时按钮自动置灰） |
| **恢复默认** | 把当前模型的大小、适配、位置和外观重置回内置默认值 |
| **隐藏模型** | 收起来，`Ctrl+Shift+L` 恢复 |
| **点击台词** | 折叠区块：气泡开关、停留时长、台词编辑 |
| **导入自己的模型** | 折叠区块：zip / 文件夹 / 本机路径三种导入方式 |

### 数值怎么调

每个数值都有三种调法，三者永远同步：

1. **拖滑块** —— 最直观。
2. **直接输入** —— 在右边的输入框里敲数字，回车或点开别处生效。超出范围会自动收到边界，敲了非法字符会退回原值。
3. **按住数字左右拖** —— 在输入框上按住横向拖动即可微调（拖满约 320px 走完整个范围），松手时如果没拖动就进入输入模式。

### 点击台词

- 展开「点击台词」，勾选 **点击模型时说话**，点模型就会弹气泡说一句随机台词。
- 文本框里 **一行一句**，点「保存台词」生效；「恢复默认台词」回到该角色的内置人设台词；「试说一句」立即预览。
- 「停留」控制气泡显示多久（2 ~ 20 秒）。
- 台词 **按模型分别保存**，可以给每个角色写符合自己口味的话。
- 切换模型时也会自动打个招呼。

内置台词都是按角色写的，例如雷姆会说「雷姆，会一直相信你的。」、
纱雾会说「哥哥，你回来啦……」，伊斯特会说「知识，就是力量哦。」

### 拖动与快捷键

**按住模型直接拖**到想放的地方，松手自动记住。拖动不会误触发点击台词。
放到屏幕上方也没问题，面板会自动收缩以免超出屏幕顶部。

| 操作 | 效果 |
| --- | --- |
| 拖动模型 | 移动位置（自动记住） |
| 单击模型 | 说一句台词 |
| `Ctrl+Shift+L` | 显示 / 隐藏模型 |
| 点 **L2D** 按钮 | 展开 / 收起控制面板 |

## 导入自己的模型

「导入自己的模型」区块提供三种方式，都会自动去掉压缩包 / 文件夹的最外层目录：

| 方式 | 适合 |
| --- | --- |
| **选择 zip 压缩包** | 最常见；模型包通常就是 zip |
| **选择模型文件夹** | 模型已经解压在磁盘上 |
| **填写本机模型目录** | 大模型：由插件直接从磁盘读取，不经过浏览器上传 |

入口文件是 **按内容识别** 的：Cubism 3/4/5 认 `FileReferences.Moc`，Cubism 2 认顶层的
`model` + `textures`。所以入口叫 `model.json`、`rem.json`、`chara-def.json` 还是别的名字都能认出来，
不必符合命名规范。同一个目录里有多个入口时（例如同一角色的多套衣服），
内置模型用显式 `entry` 指定，导入的模型可以先只放要用的那一套。

> 模型版权归原作者所有。请自行确认你有权使用所导入的模型（很多模型禁止商用或二次分发）。
> 本插件只提供加载能力，不附带任何你导入的模型。

## 内置角色

| 角色 | 出处 | Cubism |
| --- | --- | --- |
| 纱雾 · 埃罗芒阿老师 | 埃罗芒阿老师 | 2 |
| 雷姆 · Re:从零开始 | Re:从零开始的异世界生活 | 2 |
| 伊斯特 · 海王星 | 海王星 | 2 |
| 缇娅 · Live2D 官方示例 | Live2D 官方示例模型 | 2 |

<p align="center">
  <img src="docs/model-sagiri.png" alt="纱雾 · 埃罗芒阿老师" width="200">
  <img src="docs/model-rem.png" alt="雷姆 · Re:从零开始" width="200">
  <img src="docs/model-histoire.png" alt="伊斯特 · 海王星" width="200">
  <img src="docs/model-tia.png" alt="缇娅 · Live2D 官方示例" width="200">
</p>

模型资源取自公开合集 [Eikanya/Live2d-model](https://github.com/Eikanya/Live2d-model)，
**著作权归各自权利人**，不适用本插件的 MIT 许可（详见 [LICENSE](LICENSE)）。

## 工作原理

插件分 host 与 browser 两半：

```text
DSH web app
  │  tapIndex 注入 <script defer src="/dsh-live2d/widget.js">
  ▼
browser 半（Shadow DOM：画布 + 气泡 + 控制面板）
  ├─ GET  /dsh-live2d/runtime.js        Live2D 运行时（随包发布，单文件自足）
  ├─ GET  /dsh-live2d/api/state         模型清单 + 设置 + 被跳过的模型
  ├─ POST /dsh-live2d/api/settings      持久化偏好
  ├─ POST /dsh-live2d/api/import-zip    原始 zip 上传
  ├─ POST /dsh-live2d/api/import-files  文件夹上传（base64）
  ├─ POST /dsh-live2d/api/import-path   直接读本机目录
  ├─ POST /dsh-live2d/api/delete        删除导入的模型
  └─ GET  /dsh-live2d/model/<id>/<相对路径>   模型文件（prefix 路由 + ETag）
  ▲
  │  每一条路由都先过 ctx.connection.requestRejection()
host 半（lib/index.js，跑在 DSH 进程里）
```

- **Host 半** 用 `ctx.webServer.register` 注册路由、用 `ctx.webServer.tapIndex` 注入脚本；
  模型文件走一条 `prefix` 路由，路径经过 `..` 过滤 + `realpath` 校验，越权访问直接 403。
  大贴图用 ETag + `Cache-Control: immutable`，浏览器只回源一次。
  入口文件为 0 字节（文件损坏）的模型会被显式跳过，并在 `/api/state` 的 `skipped` 里说明原因，
  而不是让运行时抛出难以理解的 `Unexpected end of JSON input`。
- **Browser 半** 整只挂在 Shadow DOM 里；只在主聊天界面初始化（见下）；层级取 `z-index: 90`，
  在聊天内容之上、DSH 的浮层与弹窗之下。


### 默认值怎么来的

Live2D 模型没有统一尺寸：每个作者在自己的画布里按任意比例作画，
所以一个全局默认值不可能让所有模型都好看。`tools/calibrate.html` 会依次加载每个模型、
读回画面像素、迭代调整 `scale`/`position`，直到轮廓居中且填满画布高度 ——
内置 4 个角色的默认值就是这样量出来的（目标 88% 高度，
留出 12% 余量吸收待机动作带来的轮廓抖动）。

## 数据与设置

都在 `%USERPROFILE%\.dsh` 下，重装插件不丢：

| 路径 | 内容 |
| --- | --- |
| `.dsh-live2d.json` | 当前模型、大小、外观、每个模型的适配与位置、每个模型的自定义台词、已导入模型清单 |
| `live2d-models/<id>/` | 你导入的模型文件 |

## 权限与安全边界

- 每条自定义路由都先过 `ctx.connection.requestRejection()`：Host/Origin 被伪造（DNS 重绑定）
  或**未认证**的请求一律拒绝，和官方插件同一套信任栅栏。
- 模型文件路由做 `..` 过滤 + `realpath` 校验，符号链接也无法越出模型目录。
- 导入同时限制文件数量、单文件体积与解压后总体积，防止 zip 炸弹。
- 插件不自带沙箱：文件、Shell、sandbox 与 approval 策略完全沿用当前 DSH profile。
- 插件不联网：运行时随包发布，模型从本地磁盘读取。

## 已知限制

- 内置 4 个角色都是 **Cubism 2**；Cubism 3/4/5（`*.model3.json`）由运行时支持，可通过导入使用。
- 「适配」超过 1 会让模型超出画布而被裁切 —— 那是这个控件的本意（给画得很小的导入模型放大用），
  想要整体变大请用「大小」。
- 面板要挤在模型上方那块空间里；空间不够时（模型很大或窗口很矮）会自动改成**覆盖在模型上**显示。
- 隐藏模型只是视觉隐藏，运行时的渲染循环仍在跑；想彻底停掉请用「隐藏模型」+ 关掉页面。
- 音频静音：模型的待机动作若自带音效，播放音量为 0。

## 常见问题

**模型不见了 / 想找回来** —— 按 `Ctrl+Shift+L`；或删掉 `.dsh-live2d.json` 回到默认状态。

**点了模型不说话** —— 检查「点击台词」里的开关；台词清空后会显示占位台词「……」。

**导入报「没有找到 Live2D 模型文件」** —— 包里既没有 `*.model3.json` / `*.model.json`，
也没有任何含 `model` + `textures`（或 `FileReferences.Moc`）的 json。
有些包只放了贴图和 `.moc3`，缺模型描述文件，这种包本身不完整、任何加载器都用不了。

**导入报「不支持压缩算法」/「该 zip 已加密」** —— 换一个未加密的普通 zip；
自带解压器支持 store 与 deflate，不支持加密和分卷包。

**模型显示成一片空白 / 提示入口文件为空** —— 文件在复制过程中被截断成了 0 字节。
重新复制一次模型文件即可；插件会把这类模型列进 `skipped` 并说明原因。

**面板里少了几项** —— 「点击台词」和「导入自己的模型」默认折叠，点标题栏展开。

## 开发

```powershell
# 独立调试服务：把插件挂在桩 ctx 上，用普通 HTTP 暴露（无 DSH 鉴权，方便调试）
node tools/harness.mjs 8899
```

harness 会把 `DSH_HOME` 指到自己的临时目录（`$env:TEMP\dsh-live2d-harness-home`），
**不会读写你在用的 DSH 的设置**；需要时可用 `DSH_HARNESS_HOME` 覆盖。

| URL | 用途 |
| --- | --- |
| `http://127.0.0.1:8899/` | 模拟聊天页，看挂件 |
| `?panel=1` | 自动展开控制面板 |
| `?speak=1` | 持续显示气泡（方便截图） |
| `?ce=1` | 用 `contenteditable` 当输入框（DSH 真实形态） |
| `?boot=1` | 先显示 9 秒启动遮罩，再出现输入框（验证挂载门限） |
| `?diag=1` | 量化自检：画布尺寸、模型实际绘制尺寸、拖动、气泡、数值控件 |
| `/tools/calibrate.html` | 为新模型标定默认 `scale` / `position` |

改 `assets/live2d-widget.js` 后直接刷新页面即可；改 `lib/index.js` 需要重载插件。


## 目录结构

```text
dsh-live2d-widget/
├── cordis.patch.yml          # bundle 挂载声明
├── package.json              # dsh.bundle.patch 指向 cordis.patch.yml
├── lib/
│   ├── index.js              # Host 半：路由、模型注册表、导入、设置持久化
│   └── zip.mjs               # 零依赖 zip 解压（store + deflate + Zip64 + GBK 文件名）
├── assets/
│   ├── live2d-widget.js      # Browser 半：渲染 + 气泡 + 控制面板 + 导入 UI
│   ├── vendor/l2d.min.js     # Live2D 运行时（Cubism 2 & 6 内置，单文件自足）
│   └── models/<id>/          # 内置模型
├── docs/                     # 截图与 README 素材
└── tools/                    # 开发用，不随包发布
    ├── harness.mjs
    └── calibrate.html
```

## 致谢

- **Live2D 运行时**：[`l2d`](https://github.com/hacxy/l2d)（MIT），基于 Live2D 官方 Cubism SDK 二次封装，
  vendored 在 `assets/vendor/l2d.min.js`，同时保留其 LICENSE 与 README 便于追溯。
- **形态与注入方式**参考了 [hacxy/l2d-widget](https://github.com/hacxy/l2d-widget) 与
  [MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)。
- **模型资源**取自 [Eikanya/Live2d-model](https://github.com/Eikanya/Live2d-model)，
  著作权归各自权利人。

Cubism SDK 的使用须遵守
[Live2D Proprietary Software License](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html)。
商业用途请自行确认是否需要向 Live2D Inc. 申请许可。

## License

[MIT](LICENSE)（插件代码）。内置模型与 Cubism SDK 的授权见上文「致谢」与 [LICENSE](LICENSE)。
