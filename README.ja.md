# Harness Workspace Manager

[English](README.md) | [한국어](README.ko.md) | [简体中文](README.zh-CN.md)

Harness Workspace Manager は、再利用可能な Harness を Project に接続するローカル CLI です。Harness にはスクリプト、設定、ツールが含まれます。Project は作業対象のディレクトリです。1 つの Project に複数の Harness を接続できます。また、1 つの Harness を複数の Project で使用できます。

## 必要な環境

- Node.js 22.18 以降
- npm
- Harness マニフェストが指定する実行ファイル（例: `codex`、`claude`、Harness 専用ランチャー）

このプロジェクトは TypeScript、Node.js 組み込みのテストランナー、TOML パーサーを使用します。グローバルツールをインストールしたり、シェルの起動ファイルを変更したりしません。サーバーやデータベースも必要ありません。

## 開発用インストールと開始

```sh
npm install
npm run build
cd /path/to/coding-harness
npm --prefix /path/to/harness-workspace-manager run start -- add
cd /path/to/my-project
npm --prefix /path/to/harness-workspace-manager run start -- start
```

登録メニューで Harness のディレクトリを指定します。`harness.toml` がない場合は名前も入力します。開始メニューで Project と Harness を選択します。現在のディレクトリが未登録なら、メニューから登録できます。管理情報はマネージャーのレジストリに保存されます。

コマンドから登録することもできます。

```sh
npm --prefix /path/to/harness-workspace-manager run start -- register /path/to/coding-harness --name coding
npm --prefix /path/to/harness-workspace-manager run start -- project register /path/to/my-project --name my-project --harness coding
npm --prefix /path/to/harness-workspace-manager run start -- project doctor my-project
npm --prefix /path/to/harness-workspace-manager run start -- project open my-project --harness coding
```

登録と接続ではパスだけをレジストリに保存します。Harness や Project のファイルはコピーも変更もしません。`open` は選択した Project ディレクトリで Harness を起動します。Harness ごとに設定とセッションのディレクトリを分けます。登録済み Project 内で CLI を実行すると、その Project を自動的に選択します。

## 主なコマンド

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

Project の登録時に `--harness` を複数回指定すると、複数の Harness を接続できます。`--workspace` は接続を保存せず、指定ディレクトリで一度だけ実行します。`open --project` の前に Harness を Project に接続してください。`doctor` は既定で Harness のソースを確認します。Project を指定して検査することもできます。

`--use-harness-config NAME` は Codex のみで使用できます。Harness のソース設定を適用します。MCP サーバーや Hooks はコマンドを実行できるため、有効にする前に設定を確認してください。認証、サンドボックス、承認の設定は取り込みません。既存の接続では `project activate` と `project deactivate` を使います。

`start` は矢印キーで Project と Harness を選ぶメニューを開きます。対話型端末でない場合は `open` または `project open` を使ってください。パスを指定しない `register` または `add` は登録メニューを開きます。登録解除で削除されるのはレジストリの項目だけです。Harness と Project のファイルは残ります。

## Harness マニフェストと環境

Harness のソースディレクトリには、任意の `harness.toml` を置けます。主な項目は `name`、`harness_path`、`runtime_type`、`executable`、`args`、`config_directory`、`config_env`、`environment`、`dependencies` です。相対 `harness_path` はマニフェストのディレクトリを基準にします。相対 `config_directory` はマネージャーのデータディレクトリを基準にし、その中に収める必要があります。旧形式の `workspace_path` も読み込めます。

子プロセスには、絶対パスの `HWM_HARNESS_ROOT` と `HWM_PROJECT_ROOT` を渡します。親プロセスの環境変数はすべて自動では引き継ぎません。必要な変数は `environment.inherit` に記載するか、`environment.set` から参照してください。認証情報をマニフェストに直接書かないでください。値をログに出力することもありません。

`environment.provider` は `native`（既定）または `mise` を指定します。mise は Harness のソースにある `mise.toml` を読み込みます。マネージャーは `mise trust` や `mise install` を実行せず、ツールも自動インストールしません。設定を確認してから、必要に応じて手動で信頼を承認し、ツールをインストールしてください。`doctor` は不足バージョンを報告しますが、インストールはしません。

マニフェストの例: [`examples/coding/harness.toml`](examples/coding/harness.toml)、[`examples/writing/harness.toml`](examples/writing/harness.toml)、[`examples/research/harness.toml`](examples/research/harness.toml)。これらはテンプレートであり、登録済みの Harness ではありません。

## データとセキュリティ

マネージャーのデータディレクトリ:

- macOS: `~/Library/Application Support/Harness Workspace Manager`
- Windows: `%LOCALAPPDATA%\Harness Workspace Manager`
- Linux: `$XDG_DATA_HOME/harness-workspace-manager` または `~/.local/share/harness-workspace-manager`
- 全 OS: 起動前に `HWM_HOME` を設定すると、別の場所を使えます。

`open` のたびに、マネージャーは独立した子プロセス環境を作ります。Harness 専用の設定ディレクトリを設定し、選択した Project を作業ディレクトリにします。Native 実行は現在の OS ユーザー権限で動くため、セキュリティサンドボックスではありません。そのユーザーがアクセスできるファイルに触れる場合があります。登録や接続の際にインストールスクリプトを実行することはありません。

## 開発とテスト

```sh
npm test
npm run build
```

テストは一時ディレクトリと模擬ツールを使います。実際の認証情報、ユーザー設定、保存済みセッションは使いません。アーキテクチャの判断は [`docs/adr/0001-native-process-and-harness-home.md`](docs/adr/0001-native-process-and-harness-home.md) と [`docs/adr/0003-reusable-harnesses-and-project-links.md`](docs/adr/0003-reusable-harnesses-and-project-links.md) を参照してください。
