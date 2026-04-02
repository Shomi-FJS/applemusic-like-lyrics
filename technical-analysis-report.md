# AMLL 技术分析报告：远程控制、窗口置顶与歌词贡献者系统

## 目录

1. [远程控制功能](#1-远程控制功能)
2. [窗口置顶功能](#2-窗口置顶功能)
3. [歌词贡献者系统](#3-歌词贡献者系统)
4. [跨功能架构总结](#4-跨功能架构总结)

---

## 1. 远程控制功能

### 1.1 技术架构概述

AMLL 实现了一套**双层远程控制系统**，包含以下两个层面：

| 层级 | 协议 | 用途 | 技术选型 |
|------|------|------|----------|
| **WebSocket 服务器** | 自定义二进制（V1）+ JSON 混合（V2）协议 | 与外部播放器实时双向媒体同步 | `tokio-tungstenite`、`ws-protocol` crate |
| **HTTP REST API** | Axum Web 框架，监听端口 **13533** | 浏览器/移动端远程控制界面、播放器命令、点歌请求 | `axum`、`tower-http` |

整体架构采用**中心辐射（Hub-and-Spoke）模式**，Tauri 后端作为中心枢纽，连接 WebSocket 客户端（外部音乐播放器）、HTTP API 消费者（浏览器/远程设备）以及本地 AMLL 播放器前端。

```
┌──────────────────────────────────────────────────────────────────────┐
│                        远程客户端层                                   │
│                                                                      │
│  ┌──────────────┐   ┌──────────────┐   ┌────────────────────────┐  │
│  │ 外部音乐     │   │ 浏览器 /     │   │ BetterNCM 插件         │  │
│  │ 播放器       │   │ 移动设备     │   │ （网易云音乐）          │  │
│  │ (WS 客户端)  │   │ (HTTP+WS)    │   │ (WS 客户端)            │  │
│  └──────┬───────┘   └──────┬───────┘   └───────────┬────────────┘  │
│         │ WS V1/V2        │ HTTP REST   │ WS V1/V2               │
│         ▼                  ▼             ▼                        │
├──────────────────────────────────────────────────────────────────────┤
│                      Tauri 后端 (Rust)                              │
│                                                                      │
│  ┌─────────────────────┐  ┌──────────────────────────────────────┐  │
│  │ AMLLWebSocketServer │  │ HttpServerController (Axum :13533)  │  │
│  │ - TCP 监听器        │  │ - REST API 端点                     │  │
│  │ - 协议路由          │  │ - 静态文件服务                      │  │
│  │ - 广播消息          │  │ - WebSocket 升级推送事件            │  │
│  └──────────┬──────────┘  └──────────────┬───────────────────────┘  │
│             │                            │                           │
│             ▼                            ▼                           │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │              Tauri 事件总线 (Emitter)                        │    │
│  │  "remote-http-command" / "remote-play-song" 等              │    │
│  └──────────────────────────┬──────────────────────────────────┘    │
│                             │                                       │
│                             ▼                                       │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │              播器核心 (音频线程命令)                          │    │
│  │  PauseAudio / ResumeAudio / SetVolume / SeekAudio / ...     │    │
│  └─────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────┘
```

### 1.2 核心实现：WebSocket 服务器

**文件**: [`server.rs`](packages/player/src-tauri/src/server.rs)

`AMLLWebSocketServer` 是核心的实时通信引擎：

```rust
pub struct AMLLWebSocketServer {
    app: AppHandle,
    server_handle: Option<JoinHandle<()>>,
    connections: Connections,           // Arc<RwLock<HashMap<SocketAddr, ConnectionInfo>>>
    channel: Option<Channel<v2::Payload>>, // Tauri IPC 通道，用于向前端传递数据
    listen_addr: Option<String>,
}
```

**关键设计决策：**

- **双协议支持** — 服务器根据客户端发送的首条消息自动检测协议版本：
  - `Message::Text` 包含 JSON `{"payload":"Initialize"}` → **HybridV2**（基于 JSON）
  - `Message::Binary` → **BinaryV1**（通过 `binrw` 实现的紧凑二进制格式）

- **连接管理** — 每个连接以 `HashMap<SocketAddr, ConnectionInfo>` 的形式追踪，记录其协议类型和独立的写入端（split sink），支持并发写入。

- **自动重启机制** — 若 TCP 监听器失败，服务器会休眠 1 秒后在无限循环中重试：

```rust
self.server_handle = Some(tokio::spawn(async move {
    loop {
        info!("正在开启 WebSocket 服务器到 {addr}");
        match TcpListener::bind(&addr).await {
            Ok(listener) => {
                while let Ok((stream, _)) = listener.accept().await {
                    tokio::spawn(Self::accept_conn(
                        stream, app.clone(), connections.clone(), channel.clone(),
                    ));
                }
                warn!("WebSocket 监听器失效，正在尝试重启...");
            }
            Err(err) => error!("WebSocket 服务器 {addr} 开启失败: {err:?}"),
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}));
```

- **协议感知广播** — 广播消息时，服务器将载荷同时序列化为 V2（JSON 文本）和 V1（二进制）两种格式，并根据每个客户端的协议类型发送对应格式：

```rust
pub async fn broadcast_payload(&mut self, payload: v2::Payload) {
    let v2_msg = serde_json::to_string(&payload).ok().map(|s| Message::Text(s.into()));
    let v1_msg = if let Ok(v1_body) = v1::Body::try_from(payload.clone()) {
        v1::to_body(&v1_body).ok().map(|d| Message::Binary(d.into()))
    } else { None };
    
    for (addr, conn_info) in conns.iter_mut() {
        let msg_to_send = match conn_info.protocol {
            ProtocolType::BinaryV1 => v1_msg.as_ref(),
            ProtocolType::HybridV2 => v2_msg.as_ref(),
            _ => None,
        };
        if let Some(msg) = msg_to_send { conn_info.sink.send(msg.clone()).await; }
    }
}
```

### 1.3 核心实现：HTTP REST API 服务器

**文件**: [`http_server.rs`](packages/player/src-tauri/src/http_server.rs)

HTTP 服务器使用 **Axum** 框架，监听端口 **13533**，提供以下功能：

#### 1.3.1 路由定义

```rust
pub fn build_router(app, ws_server, dist_dir) -> Router {
    Router::new()
        .route("/api/player/now-playing", get(api_now_playing))
        .route("/api/player/play", post(|s| api_player_action(s, "play")))
        .route("/api/player/pause", post(|s| api_player_action(s, "pause")))
        .route("/api/player/next", post(|s| api_player_action(s, "next")))
        .route("/api/player/prev", post(|s| api_player_action(s, "prev")))
        .route("/api/player/fullscreen", post(api_fullscreen))
        .route("/api/player/command", post(api_player_command))
        .route("/api/player/always-on-top", post(api_always_on_top))
        .route("/api/ws/listen-addr", post(api_ws_listen_addr))
        .route("/api/player/song/:id", post(api_play_song))
        .route("/api/player/expand-url", get(api_expand_url))
        .route("/api/player/events", get(api_player_events_ws))  // WebSocket 升级端点
        .route("/", get_service(ServeFile::new(dist_dir.join("remote-index.html"))))
        .fallback_service(ServeDir::new(dist_dir))
        .layer(CorsLayer::permissive())
}
```

#### 1.3.2 命令分发模式

所有播放器控制命令遵循一致的模式：先通过 Tauri 事件通知前端，再向音频线程发送执行命令：

```rust
async fn api_player_command(State(state), Json(cmd): Json<RemoteCommand>) -> StatusCode {
    emit_remote_command(&state, &cmd);  // 通过 Tauri 事件总线通知前端
    
    let ok = match cmd {
        RemoteCommand::Pause => send_player_command(AudioThreadMessage::PauseAudio).await,
        RemoteCommand::Resume => send_player_command(AudioThreadMessage::ResumeAudio).await,
        RemoteCommand::SetVolume { volume } => {
            send_player_command(AudioThreadMessage::SetVolume { volume: volume.clamp(0.0, 1.0) }).await
        }
        RemoteCommand::SeekPlayProgress { progress } => {
            send_player_command(AudioThreadMessage::SeekAudio { position: progress.max(0.0) }).await
        }
        // ...
    };
    ok.then_some(StatusCode::OK).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)
}
```

#### 1.3.3 远程命令枚举

```rust
#[serde(tag = "command", rename_all = "camelCase")]
enum RemoteCommand {
    Pause,
    Resume,
    ForwardSong,
    BackwardSong,
    SetVolume { volume: f64 },
    SeekPlayProgress { progress: f64 },
    SetFontSize { size: String },
    ToggleTranslation { enabled: bool },
}
```

#### 1.3.4 正在播放状态管理

当前播放信息存储在全局静态变量中，使用 `LazyLock<RwLock<Option<RemoteNowPlayingInfo>>>`：

```rust
pub static REMOTE_NOW_PLAYING: LazyLock<StdRwLock<Option<RemoteNowPlayingInfo>>> =
    LazyLock::new(|| StdRwLock::new(None));

#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteNowPlayingInfo {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub is_playing: bool,
    pub cover: Option<String>,
}
```

该状态由前端通过 Tauri IPC（`update_remote_now_playing` 命令）更新，并由 HTTP API 端点读取。

#### 1.3.5 歌曲事件 WebSocket 推送

专用 WebSocket 端点 `/api/player/events` 使用 Tokio 的 `broadcast` 通道向已连接的浏览器客户端推送 `PlaySongEvent` 消息：

```rust
async fn handle_player_events_socket(mut socket: WebSocket, mut rx: broadcast::Receiver<PlaySongEvent>) {
    loop {
        tokio::select! {
            msg = rx.recv() => {
                if let Ok(event) = msg {
                    if socket.send(Message::Text(serde_json::to_string(&event)?)).await.is_err() { break; }
                }
            }
            inbound = socket.recv() => {
                match inbound {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Ping(v))) => { socket.send(Message::Pong(v)).await; }
                    _ => {}
                }
            }
        }
    }
}
```

#### 1.3.6 生命周期管理

`HttpServerController` 使用 `oneshot` 通道进行关闭信号通知，实现优雅启停：

```rust
pub struct HttpServerController {
    app: AppHandle,
    ws_server: Arc<RwLock<AMLLWebSocketServer>>,
    server_handle: Option<JoinHandle<()>>,
    shutdown_tx: Option<oneshot::Sender<()>>,
}

async fn run_http_server(app, ws_server, dist_dir, listener, shutdown_rx) {
    let router = build_router(app, ws_server, dist_dir);
    axum::serve(listener, router)
        .with_graceful_shutdown(async { let _ = shutdown_rx.await; })
        .await;
}
```

### 1.4 远程控制前端（浏览器界面）

**文件**: [`remote-index.html`](packages/player/public/remote-index.html)（1804 行）

远程控制界面是一个**单页应用（SPA）**，具备以下特性：

- **玻璃拟态（Glassmorphism）UI 设计**，支持深色/浅色主题切换
- **实时连接状态**指示器（WebSocket 连接 + 定期轮询）
- **播放器控制**：播放/暂停、上一首/下一首、进度条、音量滑块
- **设置面板**：全屏切换、窗口置顶切换、翻译开关、WebSocket 地址配置
- **点歌功能**：通过 `/api/player/song/:id` 接口
- **自动重连**逻辑：WebSocket 断开后以 2 秒间隔退避重连

关键 JavaScript 模式：

```javascript
const DEFAULT_PORT = 13533;
const API_BASE = `http://${window.location.host}/api/player`;

function connectWebSocket() {
    const wsUrl = `ws://${window.location.host}/api/player/events`;
    ws = new WebSocket(wsUrl);
    ws.onopen = () => updateConnectionStatus(true);
    ws.onmessage = (event) => handleSongEvent(JSON.parse(event.data));
    ws.onclose = () => { updateConnectionStatus(false); scheduleReconnect(); };
}

function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connectWebSocket(); }, 2000);
}

setInterval(fetchNowPlaying, 5000);  // 轮询兜底，确保状态同步
```

### 1.5 数据流图

```
用户操作（浏览器/移动端）
        │
        ▼
┌──────────────────┐     POST /api/player/command     ┌─────────────────────┐
│  远程控制前端     │ ──────────────────────────────▶  │  Axum HTTP 处理器   │
│  (HTML)           │                                   │  http_server.rs     │
└──────────────────┘                                   └────────┬────────────┘
                                                                │
                                                    emit("remote-http-command", cmd)
                                                                │
                                                                ▼
                                                   ┌────────────────────────┐
                                                   │  Tauri 事件发射器      │
                                                   │  (跨边界 IPC 通信)     │
                                                   └────────┬───────────────┘
                                                            │
                                    ┌───────────────────────┼───────────────────────┐
                                    ▼                       ▼                       ▼
                         ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
                         │ 前端 React       │  │ 音频线程         │  │ 其他监听器       │
                         │ (UI 更新)        │  │ (执行命令)       │  │ (日志等)         │
                         └──────────────────┘  └──────────────────┘  └──────────────────┘
```

### 1.6 关键库与依赖

| 库 | 用途 | 使用位置 |
|----|------|----------|
| `tokio-tungstenite` | 异步 WebSocket 服务端/客户端 | `server.rs` |
| `axum` | 高性能 HTTP Web 框架 | `http_server.rs` |
| `tower-http` | CORS 中间件、静态文件服务 | `http_server.rs` |
| `ws-protocol` (crate) | 自定义 V1/V2 协议序列化/反序列化 | `server.rs` |
| `binrw` | V1 协议的二进制序列化 | `ws-protocol` crate |
| `serde` / `serde_json` | V2 协议及 HTTP API 的 JSON 序列化 | 全局使用 |

---

## 2. 窗口置顶功能

### 2.1 技术架构概述

窗口置顶通过 **Tauri 原生窗口管理 API** 实现，封装为 Tauri 命令，可从本地前端和远程 HTTP API 双路径调用。它支持两种调用方式：

```
┌────────────────────────┐       ┌────────────────────────┐
│ 本地前端 (React)       │       │  远程控制 (HTTP)        │
│ enableAlwaysOnTopAtom  │       │  POST /always-on-top    │
└───────────┬────────────┘       └───────────┬────────────┘
            │ invoke()                       │ Axios/fetch
            ▼                                ▼
┌──────────────────────────────────────────────────────────────┐
│              set_window_always_on_top (Tauri 命令)            │
│                    lib.rs L128-L147                          │
│                                                              │
│  window.set_always_on_top(enabled)  ← Tauri/Wry 原生调用     │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
                   ┌────────────────────┐
                   │ 操作系统窗口管理器  │
                   │ (Win32 / Cocoa / X11)│
                   └────────────────────┘
```

### 2.2 核心实现：Tauri 命令

**文件**: [`lib.rs`](packages/player/src-tauri/src/lib.rs#L128-L147)

```rust
#[tauri::command]
fn set_window_always_on_top<R: Runtime>(
    enabled: bool,
    app: AppHandle<R>,
) -> Result<(), String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = (enabled, app);
        return Err("移动端不支持此功能。".to_string());
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        if let Some(window) = app.get_webview_window("main") {
            window.set_always_on_top(enabled).map_err(|e| e.to_string())
        } else {
            Err("未找到主窗口。".to_string())
        }
    }
}
```

**关键特性：**

- **平台限制** — 通过 `cfg` 属性在 Android/iOS 上显式禁用，返回错误字符串。
- **窗口定向** — 仅操作标记为 `"main"` 的 WebviewWindow，而非任意窗口。
- **错误透传** — 将操作系统级别的窗口错误直接透传给调用方。

### 2.3 远程 API 端点

**文件**: [`http_server.rs`](packages/player/src-tauri/src/http_server.rs#L304-L331)

窗口置顶功能也通过远程 HTTP API 暴露：

```rust
async fn api_always_on_top(
    State(state): State<HttpServerState>,
    Json(req): Json<AlwaysOnTopRequest>,
) -> StatusCode {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    { return StatusCode::NOT_IMPLEMENTED; }
    
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let Some(win) = state.app.get_webview_window("main") else {
            return StatusCode::NOT_FOUND;
        };
        if win.set_always_on_top(req.enabled).is_ok() {
            state.app.emit("remote-always-on-top", RemoteToggleEvent { enabled: req.enabled });
            StatusCode::OK
        } else {
            StatusCode::INTERNAL_SERVER_ERROR
        }
    }
}
```

成功更改状态后，该端点会发出 `remote-always-on-top` Tauri 事件，使本地前端能够同步其 UI 状态。

### 2.4 前端状态管理

**文件**: [`appAtoms.ts`](packages/player/src/states/appAtoms.ts#L97-L110)

前端使用 **Jotai 派生原子（derived atom）** 来桥接持久化存储与原生后端：

```typescript
const enableAlwaysOnTopInternalAtom = atomWithStorage(
    "amll-player.enableAlwaysOnTop",
    false,
);

export const enableAlwaysOnTopAtom = atom(
    (get) => get(enableAlwaysOnTopInternalAtom),
    (_get, set, enabled: boolean) => {
        set(enableAlwaysOnTopInternalAtom, enabled);
        invoke("set_window_always_on_top", { enabled }).catch((err) => {
            console.error("设置窗口置顶状态失败", err);
        });
    },
);
```

此设计模式确保：
1. **持久化** — 通过 `atomWithStorage` 将值保存到 localStorage
2. **同步** — 每次写入都会触发原生 Tauri 命令
3. **读取优化** — 从本地原子状态读取（无 IPC 开销）

### 2.5 正在播放信息集成

窗口置顶状态也包含在 `/api/player/now-playing` 响应中，使远程客户端能够显示当前状态：

```rust
let always_on_top = state.app
    .get_webview_window("main")
    .and_then(|w| w.is_always_on_top().ok())
    .unwrap_or(false);

Json(NowPlayingResponse { title, artist, album, is_playing, always_on_top, cover })
```

### 2.6 数据流汇总

| 触发方式 | 调用路径 | 机制 |
|---------|----------|------|
| 用户在 AMLL UI 中切换设置 | React → Jotai atom → `invoke("set_window_always_on_top")` | Tauri IPC 命令 |
| 用户在远程浏览器点击"置顶" | `POST /api/player/always-on-top` → Axum 处理器 → `window.set_always_on_top()` | HTTP REST API |
| 远程状态查询 | `GET /api/player/now-playing` → 读取 `window.is_always_on_top()` | HTTP GET 响应 |
| 状态变更通知 | HTTP 切换后 → `emit("remote-always-on-top")` | Tauri 事件至前端 |

---

## 3. 歌词贡献者系统

### 3.1 技术架构概述

歌词贡献者系统为**逐词歌词创作者提供归属展示功能**。它作为一个**客户端查询服务**运行，通过查询远程 TTML 数据库来查找为指定歌曲制作同步歌词的贡献者的 GitHub 用户名。

```
┌─────────────────────────────────────────────────────────────────────┐
│                     歌词贡献者数据流水线                            │
│                                                                      │
│  ┌───────────────┐    ┌──────────────────┐    ┌─────────────────┐  │
│  │ TTML 数据库   │    │ 贡献者查询服务   │    │ 歌词播放器 UI   │  │
│  │ (镜像/本地)   │◀───│ (ttml-contributor│──▶│                 │  │
│  │               │    │ -search.ts)      │    │ showLyricContributor│
│  │ amll-ttml-db  │    │                  │    │ Atom            │  │
│  │ .gbclstudio.cn│    │                  │    │                 │  │
│  └───────────────┘    └──────────────────┘    └─────────────────┘  │
│         ▲                      ▲                      ▲            │
│         │                      │                      │            │
│  NCM ID.ttml           parseTTML()            lyricContributorAtom│
│  (元数据包含作者          提取 ttmlAuthorGithubLogin               │
│   GitHub 登录名)                                               │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.2 核心实现：贡献者查询服务

**文件**: [`ttml-contributor-search.ts`](packages/player/src/utils/ttml-contributor-search.ts)

#### 3.2.1 数据源

系统支持两种数据源模式：

```typescript
const TTML_DB_BASE_URL = "https://amll-ttml-db.gbclstudio.cn/ncm-lyrics";
const LOCAL_TTML_BASE_URL = "http://localhost:3000/api/ncm-lyrics";

export type ContributorSourceMode = "mirror" | "local";
```

- **镜像模式**（默认）：查询 `gbclstudio.cn` 的公共镜像 —— 对大多数用户更快
- **本地模式**：查询本地运行的 [Lyric-Atlas-API](https://github.com/Shomi-FJS/Lyric-Atlas-API) 实例 —— 适合贡献者测试上传内容时使用

#### 3.2.2 缓存策略

使用内存中的 `Map` 缓存避免重复网络请求：

```typescript
const contributorCache = new Map<string, string | null>();
```

缓存条目以网易云音乐（NCM）歌曲 ID 为键。缓存具有以下行为：
- **填充**：每次成功查询后写入缓存
- **清除**：用户在镜像/本地源之间切换时清空缓存
- **失效**：可通过 `invalidateContributorCache()` 显式清除

#### 3.2.3 主查询函数

```typescript
export async function fetchLyricContributorByNCMId(ncmId: string): Promise<LyricMatchResult> {
    // 1. 如果有缓存结果则直接返回
    if (contributorCache.has(ncmId)) {
        return { contributor: contributorCache.get(ncmId) ?? null, matchedFile: `${ncmId}.ttml` };
    }

    try {
        // 2. 获取 TTML 文件，设置 5 秒超时
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        
        const baseUrl = contributorSource === "local" ? LOCAL_TTML_BASE_URL : TTML_DB_BASE_URL;
        const ttmlText = await fetchTtmlFromUrl(`${baseUrl}/${ncmId}.ttml`, controller.signal);
        clearTimeout(timeoutId);

        if (!ttmlText) {
            contributorCache.set(ncmId, null);
            return { contributor: null, matchedFile: null };
        }

        // 3. 解析 TTML 并提取作者元数据
        return parseTtmlContributor(ttmlText, ncmId);
    } catch (error) {
        contributorCache.set(ncmId, null);
        return { contributor: null, matchedFile: null };
    }
}
```

#### 3.2.4 TTML 解析与作者提取

```typescript
function parseTtmlContributor(ttmlText: string, ncmId: string): LyricMatchResult {
    const ttmlResult = parseTTML(ttmlText);  // 来自 @applemusic-like-lyrics/lyric
    
    // 验证：必须包含逐词歌词（而非仅行级歌词）
    const hasWordLyrics = lines.some(
        (line) => line && Array.isArray(line.words) && line.words.length > 0,
    );
    if (!hasWordLyrics) {
        contributorCache.set(ncmId, null);
        return { contributor: null, matchedFile: null };
    }

    // 从 TTML 元数据中提取作者信息
    const metadata = ttmlResult?.metadata;
    let contributor: string | null = null;
    if (metadata && Array.isArray(metadata)) {
        const authorMeta = metadata.find(
            ([key]) => key === "ttmlAuthorGithubLogin",
        );
        contributor = authorMeta?.[1]?.[0] ?? null;  // GitHub 用户名
    }

    contributorCache.set(ncmId, contributor);
    return { contributor, matchedFile: `${ncmId}.ttml` };
}
```

**关键验证步骤：** 只有具备实际逐词（word-level）歌词的歌曲才会显示贡献者归属。行级歌词（如标准 LRC）不会触发贡献者显示。

### 3.3 集成点：WS 协议上下文

**文件**: [`WSProtocolMusicContext/index.tsx`](packages/player/src/components/WSProtocolMusicContext/index.tsx#L451-L502)

当通过 WebSocket 协议接收歌词时，贡献者信息会从 TTML 载荷中内联提取：

```typescript
case "setLyric": {
    let lines: WSLyricLine[];
    let contributor: string | null = null;
    
    if (state.format === "structured") {
        lines = state.lines;
    } else {
        const ttmlResult = parseTTML(state.data);
        lines = ttmlResult.lines;
        const authorMeta = ttmlResult.metadata?.find(
            ([key]) => key === "ttmlAuthorGithubLogin",
        );
        contributor = authorMeta?.[1]?.[0] ?? null;
    }
    
    // 处理歌词...
    store.set(musicLyricLinesAtom, processed);
    
    // 仅当存在逐词歌词时才设置贡献者
    const hasWordLyrics = processed.some(
        (line) => line.words && line.words.length > 0,
    );
    if (contributor && hasWordLyrics) {
        store.set(lyricContributorAtom, contributor);
    }
    break;
}
```

### 3.4 设置界面

**文件**: [`player.tsx`](packages/player/src/pages/settings/player.tsx#L505-L570)

设置页面暴露了两个控件：

1. **显示/隐藏开关** — `showLyricContributorAtom`（带 localStorage 持久化的 Jotai 原子）：
```tsx
<SwitchSettings
    label="显示歌词贡献者"
    description="在歌词播放界面显示逐词歌词贡献者的 GitHub 用户名"
    configAtom={showLyricContributorAtom}
/>
```

2. **数据源选择器** — 在镜像源或本地数据源之间选择：
```tsx
<Select.Root value={contributorSource} onValueChange={(value) =>
    setContributorSource(value as ContributorSource)
}>
    <Select.Item value="mirror">镜像源（By @GBCLStudio）</Select.Item>
    <Select.Item value="local">本地源（缓存服务-需手动下载服务）</Select.Item>
</Select.Root>
```

### 3.5 状态原子

**文件**: [`configAtoms.ts`](packages/react-full/src/states/configAtoms.ts)

```typescript
export const showLyricContributorAtom = atomWithStorage(
    "amll-react-full.showLyricContributor",
    true,
);

export enum ContributorSource {
    Mirror = "mirror",
    Local = "local",
}

export const contributorSourceAtom = atomWithStorage<ContributorSource>(
    "amll-react-full.contributorSource",
    ContributorSource.Mirror,
);
```

### 3.6 TTML 元数据格式

贡献者的 GitHub 登录名存储在 TTML 文件的 `<metadata>` 区域下键名为 `ttmlAuthorGithubLogin` 的条目中。此内容由 TTML 编辑器工具在用户保存/上传歌词到 AMLL 歌词数据库时写入。

示例 TTML 元数据结构：
```xml
<metadata>
    <ttmlAuthorGithubLogin>某个-github-用户</ttmlAuthorGithubLogin>
</metadata>
```

### 3.7 完整数据流

```
歌曲开始播放（NCM ID: 123456）
        │
        ▼
┌───────────────────────────────────────────┐
│ WS 协议接收 "setLyric" 载荷                │
│ （或本地音乐加载 TTML 文件）               │
└───────────────────┬───────────────────────┘
                    │
                    ▼
┌───────────────────────────────────────────┐
│ parseTTML(data)                           │
│ → 提取 metadata.ttmlAuthorGithubLogin     │
│ → 检查是否存在 words[]（逐词歌词）         │
└───────────────────┬───────────────────────┘
                    │
          ┌─────────┴─────────┐
          ▼                   ▼
   存在贡献者？           无贡献者？
          │                   │
          ▼                   ▼
store.set(           store.set(
  lyricContributorAtom,  lyricContributorAtom,
  "github-user"          undefined/null
)                     )
          │                   │
          ▼                   ▼
┌───────────────────────────────────────────┐
│ PrebuiltLyricPlayer 读取：                │
│ • showLyricContributorAtom（显示开关）    │
│ • lyricContributorAtom（用户名）          │
└───────────────────┬───────────────────────┘
                    │
                    ▼
           ┌────────────────┐
           │ UI 渲染：      │
           │ "🎵 逐词同步   │
           │  by @github-user"│
           └────────────────┘
```

---

## 4. 跨功能架构总结

### 4.1 共享基础设施

这三个功能共享通用的架构模式：

| 模式 | 远程控制 | 窗口置顶 | 贡献者系统 |
|------|---------|---------|-----------|
| **后端入口** | Tauri 命令 + Axum 路由 | Tauri 命令 + Axum 路由 | 纯前端（TypeScript） |
| **状态持久化** | `REMOTE_NOW_PLAYING`（静态 RwLock） | `enableAlwaysOnTopAtom`（localStorage） | `contributorCache`（内存 Map） |
| **前后端桥梁** | `invoke()` + Tauri 事件 | `invoke()` + Tauri 事件 | 直接 `fetch()` 调用外部 API |
| **横切关注点** | CORS、优雅关闭 | 平台限制（移动端排除） | 超时处理、AbortController |

### 4.2 通信模式

```
┌─────────────────────────────────────────────────────────────┐
│                        通信矩阵                              │
│                                                             │
│    来源 \ 目标    │  Rust 后端    │  React 前端    │  远程   │
│    ─────────────┼───────────────┼───────────────┼─────────│
│  Rust 后端      │  Event Emitter│  Tauri Events  │  HTTP   │
│  React 前端     │  invoke()     │  Jotai Atoms   │  fetch()│
│  远程客户端     │  HTTP/Axum    │  N/A           │  N/A    │
└─────────────────────────────────────────────────────────────┘
```

### 4.3 文件索引

| 功能 | 核心文件 | 代码行数（约） |
|------|----------|---------------|
| **远程控制** | [`server.rs`](packages/player/src-tauri/src/server.rs) (273)、[`http_server.rs`](packages/player/src-tauri/src/http_server.rs) (499)、[`remote-index.html`](packages/player/public/remote-index.html) (1804) | ~2576 |
| **窗口置顶** | [`lib.rs`](packages/player/src-tauri/src/lib.rs#L128-L147) (20)、[`http_server.rs`](packages/player/src-tauri/src/http_server.rs#L304-L331) (28)、[`appAtoms.ts`](packages/player/src/states/appAtoms.ts#L97-L110) (14) | ~62 核心 + 集成代码 |
| **贡献者系统** | [`ttml-contributor-search.ts`](packages/player/src/utils/ttml-contributor-search.ts) (169)、[`WSProtocolMusicContext/index.tsx`](packages/player/src/components/WSProtocolMusicContext/index.tsx#L451-L502) (52)、[`player.tsx`](packages/player/src/pages/settings/player.tsx#L505-L570) (66) | ~287 |

### 4.4 技术栈汇总

| 类别 | 技术选型 |
|------|----------|
| **编程语言** | Rust（后端）、TypeScript（前端） |
| **应用框架** | Tauri v2（桌面端）、React 18（前端） |
| **Web 服务器** | Axum（HTTP）、tokio-tungstenite（WebSocket） |
| **状态管理** | Jotai（前端原子）、RwLock/LazyLock（后端） |
| **序列化** | serde/serde_json（JSON）、binrw（V1 二进制协议） |
| **协议** | 自定义 `ws-protocol` crate（V1 二进制 + V2 混合） |
| **样式方案** | CSS 自定义属性（远程 UI）、Radix UI（设置界面） |
| **歌词格式** | TTML（主要格式），支持 LRC/YRC/QRC 导入 |
