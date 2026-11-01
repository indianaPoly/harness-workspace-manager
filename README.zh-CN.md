# Harness Workspace Manager

[English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md)

Harness Workspace Manager 是一个本地 CLI，用于将可复用的 Harness 连接到 Project。Harness 包含脚本、配置和工具。Project 是实际工作的目录。一个 Project 可以连接多个 Harness；一个 Harness 也可以用于多个 Project。

## 环境要求

- Node.js 22.18 或更高版本
- npm
- Harness 清单指定的可执行文件，例如 `codex`、`claude` 或 Harness 自带的启动脚本

本项目使用 TypeScript、Node.js 内置测试运行器和 TOML 解析器。它不会安装全局工具或修改 shell 启动文件，也不需要服务器或数据库。

## 安装与快速开始

```sh
npm install
npm run build
cd /path/to/coding-harness
npm --prefix /path/to/harness-workspace-manager run start -- add
cd /path/to/my-project
npm --prefix /path/to/harness-workspace-manager run start -- start
```

注册菜单会询问 Harness 目录。如果目录中没有 `harness.toml`，菜单还会询问名称。启动菜单允许你选择 Project 和 Harness。如果当前目录尚未注册，可以在菜单中注册。管理器会把关联信息保存到自己的注册表中。

也可以使用命令注册 Harness 和 Project：

```sh
npm --prefix /path/to/harness-workspace-manager run start -- register /path/to/coding-harness --name coding
npm --prefix /path/to/harness-workspace-manager run start -- project register /path/to/my-project --name my-project --harness coding
npm --prefix /path/to/harness-workspace-manager run start -- project doctor my-project
npm --prefix /path/to/harness-workspace-manager run start -- project open my-project --harness coding
```

注册和关联只会在管理器注册表中保存路径，不会复制或修改 Harness 或 Project 文件。`open` 会在所选 Project 目录中启动 Harness。每个 Harness 使用独立的配置和会话目录。从已注册的 Project 运行 CLI 时，管理器会自动找到该 Project。

## 常用命令

```text
harness list
harness register [path] [--name NAME] [--description TEXT] [--executable COMMAND] [--config-env VARIABLE]
harness add
harness show <name>
harness unregister <name>
harness open <name> [--project NAME | --workspace PATH]
harness doctor <name> [--project NAME | --workspace PATH]
harness project register <path> [--name NAME] [--harness NAME ...]
harness project list
harness project show <name>
harness project doctor <name>
harness project attach <project> <harness> [--use-harness-config]
harness project activate <project> <harness>
harness project deactivate <project> <harness>
harness project detach <project> <harness>
harness project unregister <name>
harness project open <project> --harness <name>
harness start [harness-name]
```

注册 Project 时可以重复使用 `--harness` 来关联多个 Harness。`--workspace` 可在指定目录中临时运行，不保存关联。使用 `open --project` 前，必须先把 Harness 关联到该 Project。`doctor` 默认检查 Harness 源目录，也可以检查所选 Project。

Codex 可以通过 `--use-harness-config NAME` 应用 Harness 的部分源配置。MCP 服务器和 Hooks 可能会运行命令，因此启用前请检查 Harness 配置。管理器不会导入认证、沙箱或审批设置。已有的关联可以用 `project activate` 和 `project deactivate` 管理。

`start` 会打开终端菜单，使用方向键选择 Project 和 Harness。在非交互终端中，请使用 `open` 或 `project open`。不带路径的 `register` 或 `add` 会打开 Harness 注册菜单。注销只会移除注册表条目，不会删除 Harness 或 Project 文件。

## Harness 清单与环境

Harness 源目录可以包含可选的 `harness.toml`。主要字段包括 `name`、`harness_path`、`runtime_type`、`executable`、`args`、`config_directory`、`config_env`、`environment` 和 `dependencies`。相对的 `harness_path` 以清单目录为基准；相对的 `config_directory` 以管理器数据目录为基准，并且必须位于该目录内。旧版 `workspace_path` 清单仍受支持。

子进程会收到绝对路径形式的 `HWM_HARNESS_ROOT` 和 `HWM_PROJECT_ROOT`。父进程环境变量默认不会全部传递。请在 `environment.inherit` 中列出需要继承的变量，或在 `environment.set` 中引用它们。不要把凭据直接写入清单，也不要把凭据值写入日志。

`environment.provider` 可以是 `native`（默认）或 `mise`。mise 会读取 Harness 源目录中的 `mise.toml`。管理器不会执行 `mise trust` 或 `mise install`，也不会自动安装工具。请先检查配置；若 mise 要求信任，再手动批准并安装所需版本。`doctor` 会报告缺失版本，但不会安装它们。

示例清单：[`examples/coding/harness.toml`](examples/coding/harness.toml)、[`examples/writing/harness.toml`](examples/writing/harness.toml)、[`examples/research/harness.toml`](examples/research/harness.toml)。它们是模板，不是已安装的 Harness。

## 数据与安全边界

管理器数据目录：

- macOS：`~/Library/Application Support/Harness Workspace Manager`
- Windows：`%LOCALAPPDATA%\Harness Workspace Manager`
- Linux：`$XDG_DATA_HOME/harness-workspace-manager` 或 `~/.local/share/harness-workspace-manager`
- 所有平台：启动前设置 `HWM_HOME` 可指定其他目录。

管理器为每次 `open` 创建独立的子进程环境。它会设置 Harness 专属的配置目录，并以所选 Project 作为工作目录。Native 执行使用当前操作系统用户权限，因此它不是安全沙箱。CLI 仍可能访问该用户有权访问的文件。管理器不会运行注册或关联过程中遇到的安装脚本。

## 开发与测试

```sh
npm test
npm run build
```

测试使用临时目录和合成工具，不使用真实认证、用户配置目录或会话。架构决策见 [`docs/adr/0001-native-process-and-harness-home.md`](docs/adr/0001-native-process-and-harness-home.md) 和 [`docs/adr/0003-reusable-harnesses-and-project-links.md`](docs/adr/0003-reusable-harnesses-and-project-links.md)。
