# LexBox 架构路线

## 迁移原则

1. 前端尽量复用 `desktop/src/`，避免重写 UI。
2. Electron preload API 先通过兼容层保住调用面。
3. Rust 宿主先接状态和宿主职责，再接高复杂任务调度。
4. Node 能力允许作为过渡 sidecar 存在，但最终宿主必须由 Rust 驱动。

## 当前分层

- `src/`
  - React 入口
  - Electron 风格 `ipcRenderer` 兼容层
  - 迁移控制面
- `src-tauri/`
  - Rust 状态持久化
  - IPC 分发
  - 桌面窗口宿主
- `scripts/extract-ipc-inventory.mjs`
  - 从现有 `desktop/` 中抽取 IPC 面，给后续迁移排期

## 阶段规划

### Stage 1

- 宿主工程建立
- Settings / Spaces / Subjects 迁移
- 可运行的复用布局

### Stage 2

- Chat / CreativeChat 事件桥
- Session / Runtime / Tasks 只读能力
- 基础流式输出与工具确认

### Stage 3

- Manuscripts 工作区与文件操作
- Knowledge 文档导入与索引任务
- 本地资源协议替代

### Stage 4

- RedClaw runner
- Background task registry
- Headless worker / sidecar 协调
