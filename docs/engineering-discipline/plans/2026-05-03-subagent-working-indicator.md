# Plan: Subagent Working Indicator 개선

## 목표
subagent 실행 중 "⠙ Working..." 대신 마지막 tool 실행 정보를 실시간으로 표시하여, 사용자가 subagent의 진행 상황을 파악할 수 있게 한다.

## 작업 범위
- **In scope**: 단일/병렬 모드 모두에서 subagent 활동 추적 및 표시
- **Out of scope**: pi 코어의 `setWorkingIndicator` API 변경, 체인 모드 개선

## 아키텍처

현재 흐름:
```
pi subprocess stdout → processPiJsonLine → emitUpdate → onUpdate → renderResult
```

`processPiEvent`가 `message_end`, `turn_end`, `agent_end`만 처리 → tool 실행 중에는 onUpdate 발생 안 함.

## 변경 파일

### 1. `types.ts` — ToolActivity 타입 추가

```typescript
export interface ToolActivity {
  name: string;
  args: Record<string, unknown>;
  timestamp: number;
}
```

`SingleResult`에 추가:
```typescript
lastActivity?: ToolActivity;
```

### 2. `runner-events.ts` — tool_start 이벤트 추적

`processPiEvent`에 `tool_start` 케이스 추가:
```typescript
case "tool_start": {
  if (typeof event.name === "string") {
    result.lastActivity = {
      name: event.name,
      args: event.arguments || {},
      timestamp: Date.now(),
    };
    return true; // onUpdate 트리거
  }
  return false;
}
```

### 3. `subagent.ts` — 단일 모드 heartbeat 추가

`runAgent`의 네이티브 실행 블록(`executionMode !== "tmux"`)에서 프로세스 spawn 후 heartbeat 타이머 추가:

```typescript
const HEARTBEAT_MS = 2000;

// spawn 이후에 추가
let heartbeat: ReturnType<typeof setInterval> | undefined;
if (onUpdate) {
  heartbeat = setInterval(() => {
    if (!didClose && !settled) emitUpdate();
  }, HEARTBEAT_MS);
}

// finish 함수 내에서 정리
if (heartbeat) clearInterval(heartbeat);
```

### 4. `render.ts` — 마지막 활동 표시

`renderSingleResult`에서 running 상태(`exitCode === -1`)일 때 `lastActivity` 표시:

```typescript
// collapsed 뷰에서 running + lastActivity
if (r.exitCode === -1 && r.lastActivity) {
  text += `\n${fg("muted", "→ ")}${formatToolCall(r.lastActivity.name, r.lastActivity.args, fg)}`;
}
```

병렬 모드의 `renderParallelResult`에서도 동일하게 적용.

## Self-Review

- [ ] `types.ts` 변경이 기존 인터페이스를 깨뜨리지 않는가? (선택적 필드 추가만)
- [ ] `processPiEvent`의 `tool_start` 처리가 기존 `message_end` 로직에 영향 없나?
- [ ] heartbeat가 프로세스 종료 시 정확히 정리되는가? (memory leak 방지)
- [ ] tmux 모드에서도 동작하는가? (tmux는 별도 poll 루프 → 이미 flushLine에서 처리)
- [ ] 병렬 모드 heartbeat와 단일 모드 heartbeat가 충돌하지 않는가? (별도 스코프)
