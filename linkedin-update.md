# LinkedIn Post: roach-pi 최근 업데이트 요약

---

> 이 글은 **roach-pi** (pi-coding-agent 용 엔지니어링 규율 확장팩)의 v1.10 → v1.20.1 구간 주요 변경사항을 정리한 LinkedIn 포스트 원고입니다.

---

## 제목: AI 코딩 에이전트에 '엔지니어링 규율'을 심다 — roach-pi 1.20 출시

---

요즘 AI 코딩 에이전트가 코드를 대신 짜주는 건 놀랍지 않은데,

**"그 코드가 진짜 제대로 동작할지, 왜 그렇게 짰는지, 중간에 실패하면 어떻게 복구할지"** 를 보장해주는 에이전트는 아직 많지 않습니다.

저는 최근 3주 동안 pi-coding-agent 의 확장팩인 **roach-pi** 에서 이 문제를 집중적으로 파고들었습니다. v1.10 에서 v1.20.1 까지, 주 단위로 빠르게 릴리즈하며 쌓아온 기능들을 공유해봅니다.

---

### 1. Plan Progress Tracker — 계획의 실행 상태를 추적한다

계획을 세우는 건 쉽지만, 그 계획이 실제로 *잘 실행되고 있는지*를 추적하는 건 또 다른 문제입니다.

**Milestone Tracking 시스템**을 도입했습니다:

- 마일스톤 단위로 상태(pending → planning → executing → validating → completed)를 추적
- PlanProgressTracker 가 task 별 상태 스냅샷을 찍고, 세션 재시작 시에도 복구 가능
- CustomEntries 에 프로그레스 정보를 저장해 크래시 내성 확보
- 서브에이전트 실행 중에도 실시간 프로그레스 반영

**왜 이게 중요하냐면:** AI 에이전트가 30분짜리 작업을 하다가 중간에 실패했을 때, "어디까지 했는지"를 알 수 있어야 다시 이어서 할 수 있기 때문입니다. 사람과 협업할 때처럼요.

### 2. Async Subagent — 백그라운드 실행과 상태 관리

기존 subagent 는 동기식이라 큰 작업을 던져놓고 기다려야 했습니다.

이제 **async spawn** 을 통해:

- `{ async: true }` 옵션으로 즉시 runId 를 받고 백그라운드 실행
- `{ action: status }` / `{ action: interrupt, id }` 로 실행 중인 작업의 상태 조회 및 중단
- 완료 시 자동 알림 (sendUserMessage)
- ToolActivity, RunProgress, AsyncRunRecord 타입으로 실시간 진행률 추적

**RunRegistry** 라는 인메모리 + 디스크 영속성 레지스트리를 만들어서 프로세스 생애주기를 관리합니다. 527 개 테스트 통과.

### 3. LSP Client — 에디터 수준의 코드 인텔리전스를 터미널로

AI 에이전트가 코드를 분석할 때 단순 텍스트 검색만으로는 한계가 있습니다.

**pi-lsp-client** 확장을 통해:

- typescript-language-server 기반으로 TypeScript 진단, 심볼 탐색, 리네임 지원
- 에이전트가 코드의 구조적 맥락을 이해하고 리팩토링 제안 가능

LSP 를 에이전트 워크플로우에 통합한 사례는 아직 많지 않은데, 이 부분이 재미있는 실험입니다.

### 4. Nested AGENTS.md — 계층적 컨텍스트 자동 주입

**pi-nested-agents-md** 확장으로, 에이전트가 작업 중인 디렉토리부터 상위 디렉토리까지 AGENTS.md 륄 자동으로 찾아 주입합니다.

프로젝트 구조가 깊어질수록 필요한 컨텍스트를 자동으로 찾아준다는 점에서 실용적입니다.

### 5. Team Mode — tmux 기반 멀티 에이전트 오케스트레이션

팀 모드는 에이전트가 여러 작업자를 동시에 실행할 수 있게 해줍니다.

- **PI_ENABLE_TEAM_MODE** 피처 플래그로 점진적 롤아웃
- tmux 백엔드로 각 워커를 분리된 세션에서 실행
- durable inbox 기반으로 작업 명령/상태 관리
- 마우스 스크롤 지원으로 터미널 UX 개선

한 에이전트가 전체를 다 하는 게 아니라, 여러 스페셜리스트 에이전트가 협업하는 구조로 가는 첫걸음입니다.

### 6. FFF Search — 퍼지 파일 검색 엔진 업그레이드

**@ff-labs/fff-node** 를 0.5.2 → 0.6.4 로 업그레이드:

- find/grep/multi_grep 명령이 FFF 엔진 기반으로 동작
- git 인지 인덱싱, 랭킹, 페이지네이션, smart-case
- `/fff-mode`, `/fff-health`, `/fff-rescan` 명령으로 제어

파일 찾기에서 "아 맞다 그 파일 이름이..." 하는 순간을 줄여줍니다.

### 7. 그 외 이것저것

- **Workspace Memory** (v1.10): 에이전트가 작업 중인 프로젝트의 맥락을 자동 저장/회수, 스코어링 기반 eviction
- **Session Loop** (v1.11): `/loop <interval> <prompt>` 로 주기적 작업 스케줄링
- **Clarification Priority** (v1.16): 에이전트가 모호함을 만났을 때 우선순위를 정하는 영어 시스템 명령어 추가
- **pi v0.72 호환성** (v1.18~v1.20): 의존성 고정 및 UX 호환성 확보

---

### 배운 점

이번 작업에서 가장 크게 느낀 건, **AI 에이전트의 신뢰성은 거의 대부분 상태 관리에서 결정된다**는 점입니다.

에이전트가 아무리 똑똑해도, "지금까지 뭘 했는지"를 모르면 다음 스텝을 정할 수 없습니다. Plan Progress Tracker 의 robustness 를 강화하면서 이 부분을 절감했습니다.

또 하나는 **릴리즈 자동화의 중요성**. semantic-release 로 버전 관리 + CHANGELOG 생성을 완전 자동화하면서, "배포 두려움"이 확 줄었습니다. 기능 단위로 쪼개서 자주 릴리즈하는 습관이 생겼습니다.

---

전체 코드는 GitHub 에 공개되어 있습니다:
https://github.com/tmdgusya/roach-pi

설치:
```bash
pi install git:github.com/tmdgusya/pi-engineering-discipline-extension
```

---

**해시태그**
#AI #CodingAgent #DeveloperTools #TypeScript #OpenSource #LLM #AgenticWorkflow

---

*쓰고 보니 되게 많은 걸 짧게 한 3주 동안 한 것 같네요. 근데 아직 할 게 더 많아요. 계속합니다.*
