# Harness Workspace Manager

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

**Harness는 도구와 규칙이 있는 폴더입니다. Project는 작업할 코드가 있는 폴더입니다.** 한 Project에 여러 Harness를 연결할 수 있습니다. 작업할 때 사용할 Harness를 선택합니다.

## 처음 한 번만 설정

매니저 폴더에서 의존성을 설치하고 빌드합니다.

```sh
npm install
npm run build
```

Harness 폴더에 들어가 등록 메뉴를 엽니다. 메뉴에서 폴더와 이름을 입력합니다. `harness.toml`이 있으면 그 안의 이름을 사용합니다.

```sh
cd /path/to/coding-harness
npm --prefix /path/to/harness-workspace-manager run start -- add
```

원본 Harness 파일은 옮기거나 복사하지 않습니다. 명령으로 직접 등록할 수도 있습니다.

```sh
npm --prefix /path/to/harness-workspace-manager run start -- register /path/to/coding-harness --name coding
```

## Project에서 Harness 사용하기

Project 폴더로 이동한 뒤 매니저의 시작 메뉴를 엽니다.

```sh
cd /path/to/my-project
npm --prefix /path/to/harness-workspace-manager run start -- start
```

메뉴에서 Project와 Harness를 선택합니다. 현재 폴더가 등록되지 않았다면 메뉴에서 등록할 수 있습니다. 매니저는 선택한 Harness를 해당 Project에 연결합니다. 다음에 다른 Harness를 사용하려면 `start`를 다시 실행하십시오.

이미 등록한 Project라면 CLI로 바로 실행할 수도 있습니다.

```sh
npm --prefix /path/to/harness-workspace-manager run start -- project register /path/to/my-project --name my-project --harness coding --harness writing
npm --prefix /path/to/harness-workspace-manager run start -- project doctor my-project
npm --prefix /path/to/harness-workspace-manager run start -- project open my-project --harness coding
npm --prefix /path/to/harness-workspace-manager run start -- project open my-project --harness writing
```

한 Project에 여러 Harness를 연결하려면 `--harness`를 반복하십시오. 매니저는 연결 정보를 Registry에 저장합니다. Project 파일은 변경하지 않습니다. 한 Harness를 여러 Project에 연결할 수도 있습니다.

## Harness 설정 적용

Harness 폴더에 `harness.toml`이 있으면 매니저가 그 설정을 읽습니다. 없으면 매니저가 자기 데이터 폴더에 Manifest를 만듭니다. `executable`에는 `codex`, `claude` 또는 Harness가 제공하는 실행 스크립트를 지정할 수 있습니다. Harness 스크립트는 실행 중 다음 경로를 받습니다.

- `HWM_HARNESS_ROOT`: Harness 원본 폴더
- `HWM_PROJECT_ROOT`: 작업할 Project 폴더

자신의 스크립트를 사용하는 Harness는 `executable = "./scripts/run"`처럼 지정할 수 있습니다. 상대 실행 경로는 Harness 원본 폴더 기준이며, 스크립트는 `HWM_PROJECT_ROOT`에서 작업을 시작하면 됩니다.

기존 `coding` Harness에는 `.codex/config.toml`과 Skills가 있습니다. Codex는 다른 Project에서 실행될 때 그 원본 설정을 자동으로 읽지 않습니다. 적용하려면 Project를 연결할 때 명시적으로 선택합니다.

```sh
npm --prefix /path/to/harness-workspace-manager run start -- project register /path/to/my-project --name my-project --harness coding --use-harness-config coding
```

매니저는 이 선택에 따라 원본 설정의 MCP·Skills·Hooks 등을 전용 Codex 프로필에 반영합니다. MCP와 Hooks는 명령을 실행할 수 있습니다. 따라서 선택 전에 원본 설정을 검토하십시오. 매니저는 인증·샌드박스·승인 설정을 가져오지 않습니다. 기존 연결의 설정 적용은 다음 명령으로 켜거나 끌 수 있습니다.

```sh
npm --prefix /path/to/harness-workspace-manager run start -- project activate my-project coding
npm --prefix /path/to/harness-workspace-manager run start -- project deactivate my-project coding
```

Codex 프로젝트 설정과 Skills는 Codex의 신뢰 및 로딩 규칙도 따릅니다. 사용자가 따로 만든 Launcher가 있으면 그 스크립트에서 Harness 설정을 적용할 수 있습니다. 매니저는 Harness의 `scripts/install.sh`를 자동 실행하지 않습니다.

## 도구 버전과 mise

Harness의 `harness.toml`에서 `environment.provider`를 `native` 또는 `mise`로 지정합니다. `mise`를 선택하면 Harness 폴더의 `mise.toml`에 적힌 도구 버전과 환경 변수를 사용합니다. `native` Harness는 mise 없이 실행됩니다.

매니저는 도구를 자동으로 설치하지 않습니다. mise의 trust 승인도 대신하지 않습니다. 설정을 검토하십시오. mise가 승인을 요구하면 직접 승인한 뒤 `mise install`을 실행하십시오. mise가 설치되지 않았다면 `doctor`가 설치 방법을 안내합니다.

## 분리되는 것과 공유되는 것

각 Harness는 별도의 Codex·Claude 설정 경로와 세션 경로를 사용합니다. Harness별 환경 변수도 분리됩니다. 선택한 Project가 작업 폴더가 됩니다. Native 실행은 현재 사용자 권한을 사용합니다. 파일 접근을 막는 보안 샌드박스는 아닙니다. 실제 읽기·쓰기 범위는 Codex나 Claude의 권한 설정에 따릅니다.

새 Harness 프로필에서는 Codex나 Claude에 한 번 로그인해야 할 수 있습니다. 매니저는 기존 인증 정보를 복사하지 않습니다. `unregister`는 Registry 연결만 제거하며 Harness·Project 파일이나 프로필 데이터는 삭제하지 않습니다.

## 확인 명령

```sh
npm --prefix /path/to/harness-workspace-manager run start -- list
npm --prefix /path/to/harness-workspace-manager run start -- show coding
npm --prefix /path/to/harness-workspace-manager run start -- doctor coding --project my-project
npm --prefix /path/to/harness-workspace-manager test
```

테스트는 임시 Project와 합성 Harness를 사용합니다. 실제 계정 인증이나 기존 세션 파일은 사용하지 않습니다.
