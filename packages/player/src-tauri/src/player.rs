use std::sync::{LazyLock, RwLock as StdRwLock};

use amll_player_core::AudioThreadEvent;
use amll_player_core::AudioThreadEventMessage;
use amll_player_core::AudioThreadMessage;
use amll_player_core::{AudioPlayer, AudioPlayerConfig, AudioPlayerHandle};
use base64::Engine;
use rodio::OutputStream;
use rodio::OutputStreamBuilder;
use tauri::{AppHandle, Emitter, Runtime};
use tokio::sync::RwLock;
use tracing::error;
use tracing::warn;

pub static PLAYER_HANDLER: LazyLock<RwLock<Option<AudioPlayerHandle>>> =
    LazyLock::new(|| RwLock::new(None));

#[derive(Clone)]
pub struct NowPlayingSnapshot {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub is_playing: bool,
    pub cover_data_url: Option<String>,
}

pub static NOW_PLAYING: LazyLock<StdRwLock<Option<NowPlayingSnapshot>>> =
    LazyLock::new(|| StdRwLock::new(None));

pub async fn send_player_command(msg: AudioThreadMessage) -> bool {
    if let Some(handler) = &*PLAYER_HANDLER.read().await {
        handler.send_anonymous(msg).await.is_ok()
    } else {
        false
    }
}

#[tauri::command]
pub async fn local_player_send_msg(msg: AudioThreadEventMessage<AudioThreadMessage>) {
    if let Some(handler) = &*PLAYER_HANDLER.read().await
        && let Err(err) = handler.send(msg).await
    {
        warn!("failed to send msg to local player: {:?}", err);
    }
}

#[tauri::command]
pub async fn set_media_controls_enabled(enabled: bool) {
    if let Some(handler) = &*PLAYER_HANDLER.read().await {
        let msg = AudioThreadMessage::SetMediaControlsEnabled { enabled };
        if let Err(err) = handler.send_anonymous(msg).await {
            warn!(
                "failed to send SetMediaControlsEnabled msg to local player: {:?}",
                err
            );
        }
    }
}

pub fn init_local_player<R: Runtime>(app: AppHandle<R>) {
    std::thread::spawn(move || {
        let stream = OutputStreamBuilder::open_default_stream().expect("无法创建默认的音频输出流");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("创建 Tokio 运行时失败");

        runtime.block_on(local_player_main(app, stream));
    });
}

async fn local_player_main<R: Runtime>(app: AppHandle<R>, stream: OutputStream) {
    let player = AudioPlayer::new(AudioPlayerConfig {}, stream);
    let handler = player.handler();
    PLAYER_HANDLER.write().await.replace(handler);
    let app_clone = app.clone();
    player
        .run(move |evt| {
            if let Some(evt_data) = evt.data() {
                if let AudioThreadEvent::SyncStatus {
                    music_info,
                    is_playing,
                    ..
                } = evt_data.clone()
                {
                    let cover_data_url = music_info.cover.and_then(|cover| {
                        if cover.is_empty() {
                            return None;
                        }
                        let media_type = if music_info.cover_media_type.is_empty() {
                            "image/jpeg"
                        } else {
                            music_info.cover_media_type.as_str()
                        };
                        let base64 = base64::engine::general_purpose::STANDARD.encode(cover);
                        Some(format!("data:{media_type};base64,{base64}"))
                    });
                    let snapshot = NowPlayingSnapshot {
                        title: music_info.name.clone(),
                        artist: music_info.artist.clone(),
                        album: music_info.album.clone(),
                        is_playing,
                        cover_data_url,
                    };
                    if let Ok(mut guard) = NOW_PLAYING.write() {
                        guard.replace(snapshot.clone());
                    }
                    let remote_info = crate::RemoteNowPlayingInfo {
                        title: music_info.name,
                        artist: music_info.artist,
                        album: music_info.album,
                        is_playing,
                        cover: snapshot.cover_data_url,
                    };
                    if let Ok(mut guard) = crate::REMOTE_NOW_PLAYING.write() {
                        guard.replace(remote_info);
                    }
                }
            }
            if let Err(err) = app_clone.emit("plugin:player-core-event", &evt) {
                error!("发送事件时出错: {err:?}");
            }
        })
        .await;
}
