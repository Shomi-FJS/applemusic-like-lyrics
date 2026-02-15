import { FFTPlayer } from "@applemusic-like-lyrics/fft";
import { parseTTML } from "@applemusic-like-lyrics/lyric";
import {
	fftDataAtom,
	fftDataRangeAtom,
	hideLyricViewAtom,
	isLyricPageOpenedAtom,
	isShuffleActiveAtom,
	musicAlbumNameAtom,
	musicArtistsAtom,
	musicCoverAtom,
	musicDurationAtom,
	musicIdAtom,
	musicLyricLinesAtom,
	musicNameAtom,
	musicPlayingAtom,
	musicPlayingPositionAtom,
	musicVolumeAtom,
	onChangeVolumeAtom,
	onClickControlThumbAtom,
	onCycleRepeatModeAtom,
	onLyricLineClickAtom,
	onPlayOrResumeAtom,
	onRequestNextSongAtom,
	onRequestPrevSongAtom,
	onSeekPositionAtom,
	onToggleShuffleAtom,
	RepeatMode,
	repeatModeAtom,
} from "@applemusic-like-lyrics/react-full";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { type FC, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";
import {
	wsProtocolConnectedAddrsAtom,
	wsProtocolListenAddrAtom,
} from "../../states/appAtoms.ts";
import { emitAudioThread } from "../../utils/player.ts";
import { FFTToLowPassContext } from "../LocalMusicContext/index.tsx";

interface WSArtist {
	id: string;
	name: string;
}

interface WSLyricWord {
	startTime: number;
	endTime: number;
	word: string;
	romanWord: string;
}

interface WSLyricLine {
	startTime: number;
	endTime: number;
	words: WSLyricWord[];
	isBG: boolean;
	isDuet: boolean;
	translatedLyric: string;
	romanLyric: string;
}

interface WSMusicInfo {
	musicId: string;
	musicName: string;
	albumId: string;
	albumName: string;
	artists: WSArtist[];
	duration: number;
}

interface WSImageData {
	mimeType: string;
	data: string;
}

interface RemotePlaySongEvent {
	id: string;
	source: string;
}

interface RemoteToggleEvent {
	enabled: boolean;
}

type WSAlbumCover =
	| { source: "uri"; url: string }
	| { source: "data"; image: WSImageData };

type WSLyricContent =
	| { format: "structured"; lines: WSLyricLine[] }
	| { format: "ttml"; data: string };

type WSCommand =
	| { command: "pause" }
	| { command: "resume" }
	| { command: "forwardSong" }
	| { command: "backwardSong" }
	| { command: "setVolume"; volume: number }
	| { command: "seekPlayProgress"; progress: number }
	| { command: "setRepeatMode"; mode: RepeatMode }
	| { command: "setShuffleMode"; enabled: boolean };

type WSStateUpdate =
	| ({ update: "setMusic" } & WSMusicInfo)
	| ({ update: "setCover" } & WSAlbumCover)
	| ({ update: "setLyric" } & WSLyricContent)
	| { update: "progress"; progress: number }
	| { update: "volume"; volume: number }
	| { update: "paused" }
	| { update: "resumed" }
	| { update: "audioData"; data: number[] }
	| { update: "modeChanged"; repeat: RepeatMode; shuffle: boolean };

type WSPayload =
	| { type: "initialize" }
	| { type: "ping" }
	| { type: "pong" }
	| { type: "command"; value: WSCommand }
	| { type: "state"; value: WSStateUpdate };

type SmtcEvent =
	| { type: "audioData"; data: number[] }
	| { type: string; data: unknown };

interface WSProtocolMusicContextProps {
	isLyricOnly?: boolean;
}

export const WSProtocolMusicContext: FC<WSProtocolMusicContextProps> = ({
	isLyricOnly = false,
}) => {
	const wsProtocolListenAddr = useAtomValue(wsProtocolListenAddrAtom);
	const setConnectedAddrs = useSetAtom(wsProtocolConnectedAddrsAtom);
	const setIsLyricPageOpened = useSetAtom(isLyricPageOpenedAtom);
	const store = useStore();
	const { t } = useTranslation();
	const fftPlayer = useRef<FFTPlayer | undefined>(undefined);
	const fftDataRange = useAtomValue(fftDataRangeAtom);
	const lastWsAudioDataAt = useRef<number>(0);
	const isSystemAudioActive = useRef(false);

	const showRemoteNotification = (message: string, autoClose = 1800) => {
		toast.info(message, { position: "top-right", autoClose });
	};

	const getRemoteCommandMessage = (command: WSCommand) => {
		switch (command.command) {
			case "pause":
				return t("ws-protocol.remoteCommand.pause", "远程用户执行：暂停");
			case "resume":
				return t("ws-protocol.remoteCommand.resume", "远程用户执行：播放");
			case "forwardSong":
				return t(
					"ws-protocol.remoteCommand.forwardSong",
					"远程用户执行：下一首",
				);
			case "backwardSong":
				return t(
					"ws-protocol.remoteCommand.backwardSong",
					"远程用户执行：上一首",
				);
			case "setVolume": {
				const volumeText = `${Math.round(command.volume * 100)}%`;
				return t(
					"ws-protocol.remoteCommand.setVolume",
					"远程用户执行：设置音量 {volume}",
					{
						volume: volumeText,
					},
				);
			}
			case "seekPlayProgress": {
				const seconds = Math.max(0, Math.floor(command.progress / 1000));
				return t(
					"ws-protocol.remoteCommand.seekPlayProgress",
					"远程用户执行：跳转到 {seconds}s",
					{ seconds },
				);
			}
			case "setRepeatMode":
			case "setShuffleMode":
				return t(
					"ws-protocol.remoteCommand.playMode",
					"远程用户执行：调整播放模式",
				);
			default:
				return t("ws-protocol.remoteCommand.unknown", "远程用户执行：执行操作");
		}
	};

	useEffect(() => {
		if (!isLyricOnly) {
			emitAudioThread("pauseAudio");
		}
	}, [isLyricOnly]);

	useEffect(() => {
		let canceled = false;
		const fft = new FFTPlayer();
		fft.setFreqRange(fftDataRange[0], fftDataRange[1]);
		fftPlayer.current = fft;
		const result = new Float32Array(64);

		const onFFTFrame = () => {
			if (canceled) return;
			fftPlayer.current?.read(result);
			store.set(fftDataAtom, [...result]);
			requestAnimationFrame(onFFTFrame);
		};

		requestAnimationFrame(onFFTFrame);

		return () => {
			canceled = true;
			fftPlayer.current?.free();
			fftPlayer.current = undefined;
		};
	}, [fftDataRange, store]);

	const systemAudioUnlistenRef = useRef<(() => void) | null>(null);

	const stopSystemAudio = useCallback(async () => {
		if (!isSystemAudioActive.current) {
			return;
		}
		isSystemAudioActive.current = false;
		if (systemAudioUnlistenRef.current) {
			systemAudioUnlistenRef.current();
			systemAudioUnlistenRef.current = null;
		}
		try {
			await invoke("control_external_media", {
				payload: { type: "stopAudioVisualization" },
			});
		} catch (error) {
			console.warn("停止系统音频监听失败:", error);
		}
	}, []);

	const startSystemAudio = useCallback(async () => {
		if (isSystemAudioActive.current) {
			return;
		}
		isSystemAudioActive.current = true;
		try {
			const unlistenLocal = await listen<SmtcEvent>("smtc_update", (event) => {
				if (event.payload.type !== "audioData") {
					return;
				}
				if (!isSystemAudioActive.current) {
					return;
				}
				const lastWsTime = lastWsAudioDataAt.current;
				if (lastWsTime && Date.now() - lastWsTime < 3000) {
					return;
				}
				if (fftPlayer.current) {
					const data = event.payload.data as number[];
					fftPlayer.current.pushDataF32(
						48000,
						2,
						new Float32Array(new Uint8Array(data).buffer),
					);
				}
			});

			if (!isSystemAudioActive.current) {
				unlistenLocal();
				return;
			}

			systemAudioUnlistenRef.current = unlistenLocal;
			await invoke("control_external_media", {
				payload: { type: "startAudioVisualization" },
			});
		} catch (error) {
			isSystemAudioActive.current = false;
			console.warn("启动系统音频监听失败:", error);
		}
	}, []);

	useEffect(() => {
		if (!wsProtocolListenAddr && !isLyricOnly) {
			return;
		}

		let timerId: number | null = null;

		const checkFallback = () => {
			const now = Date.now();
			const lastWsTime = lastWsAudioDataAt.current;
			const shouldFallback = !lastWsTime || now - lastWsTime > 3000;
			if (shouldFallback) {
				startSystemAudio();
			} else {
				stopSystemAudio();
			}
			timerId = window.setTimeout(checkFallback, 1000);
		};

		checkFallback();

		return () => {
			if (timerId !== null) {
				clearTimeout(timerId);
			}
			stopSystemAudio();
		};
	}, [wsProtocolListenAddr, isLyricOnly, startSystemAudio, stopSystemAudio]);

	useEffect(() => {
		if (!wsProtocolListenAddr && !isLyricOnly) {
			return;
		}

		setConnectedAddrs(new Set());

		if (!isLyricOnly) {
			store.set(musicNameAtom, "等待连接中");
			store.set(musicAlbumNameAtom, "");
			store.set(musicCoverAtom, "");
			store.set(musicArtistsAtom, []);
			store.set(isShuffleActiveAtom, false);
			store.set(repeatModeAtom, RepeatMode.Off);
		}

		function sendWSCommand(command: WSCommand) {
			const payload: WSPayload = { type: "command", value: command };
			invoke("ws_broadcast_payload", { payload });
		}

		if (!isLyricOnly) {
			const toEmit = <T,>(onEmit: T) => ({ onEmit });
			store.set(
				onToggleShuffleAtom,
				toEmit(() => {
					const currentShuffle = store.get(isShuffleActiveAtom);
					sendWSCommand({
						command: "setShuffleMode",
						enabled: !currentShuffle,
					});
				}),
			);
			store.set(
				onCycleRepeatModeAtom,
				toEmit(() => {
					const currentRepeat = store.get(repeatModeAtom);
					const nextMode: RepeatMode =
						currentRepeat === RepeatMode.Off
							? RepeatMode.All
							: currentRepeat === RepeatMode.All
								? RepeatMode.One
								: RepeatMode.Off;
					sendWSCommand({ command: "setRepeatMode", mode: nextMode });
				}),
			);
			store.set(
				onRequestNextSongAtom,
				toEmit(() => sendWSCommand({ command: "forwardSong" })),
			);
			store.set(
				onRequestPrevSongAtom,
				toEmit(() => sendWSCommand({ command: "backwardSong" })),
			);
			store.set(
				onPlayOrResumeAtom,
				toEmit(() => {
					const command = store.get(musicPlayingAtom) ? "pause" : "resume";
					sendWSCommand({ command });
				}),
			);
			store.set(
				onSeekPositionAtom,
				toEmit((progress) => {
					sendWSCommand({
						command: "seekPlayProgress",
						progress: progress | 0,
					});
				}),
			);
			store.set(
				onLyricLineClickAtom,
				toEmit((evt, playerRef) => {
					sendWSCommand({
						command: "seekPlayProgress",
						progress: evt.line.getLine().startTime | 0,
					});
					playerRef?.lyricPlayer?.resetScroll();
				}),
			);
			store.set(
				onChangeVolumeAtom,
				toEmit((volume) => {
					sendWSCommand({ command: "setVolume", volume });
				}),
			);
			store.set(
				onClickControlThumbAtom,
				toEmit(() => setIsLyricPageOpened(false)),
			);
		}

		const unlistenConnected = listen<string>(
			"on-ws-protocol-client-connected",
			(evt) => {
				invoke("ws_broadcast_payload", {
					payload: { type: "ping" },
				});
				setConnectedAddrs((prev) => new Set([...prev, evt.payload]));
			},
		);

		const unlistenRemoteHttp = listen<WSCommand>(
			"remote-http-command",
			(evt) => {
				sendWSCommand(evt.payload);
				const message = getRemoteCommandMessage(evt.payload);
				if (message) {
					showRemoteNotification(message);
				}
			},
		);
		const unlistenRemotePlaySong = listen<RemotePlaySongEvent>(
			"remote-play-song",
			() => {
				showRemoteNotification(
					t("ws-protocol.remoteCommand.requestSong", "远程用户执行：点歌"),
					3000,
				);
			},
		);
		const unlistenRemoteFullscreen = listen<RemoteToggleEvent>(
			"remote-fullscreen",
			(evt) => {
				const message = evt.payload.enabled
					? t(
							"ws-protocol.remoteCommand.fullscreenOn",
							"远程用户执行：开启全屏",
						)
					: t(
							"ws-protocol.remoteCommand.fullscreenOff",
							"远程用户执行：退出全屏",
						);
				showRemoteNotification(message);
			},
		);
		const unlistenRemoteAlwaysOnTop = listen<RemoteToggleEvent>(
			"remote-always-on-top",
			(evt) => {
				const message = evt.payload.enabled
					? t(
							"ws-protocol.remoteCommand.alwaysOnTopOn",
							"远程用户执行：开启窗口置顶",
						)
					: t(
							"ws-protocol.remoteCommand.alwaysOnTopOff",
							"远程用户执行：关闭窗口置顶",
						);
				showRemoteNotification(message);
			},
		);

		let curCoverBlobUrl = "";
		let remoteCoverUrl = "";
		const onBodyChannel = new Channel<WSPayload>();

		const emitRemoteNowPlaying = (nextIsPlaying: boolean) => {
			const title = store.get(musicNameAtom) || "";
			const album = store.get(musicAlbumNameAtom) || "";
			const artists = store.get(musicArtistsAtom) || [];
			const artistNames = artists.map((v) => v.name).join(" / ");
			invoke("update_remote_now_playing", {
				info: {
					title,
					artist: artistNames,
					album,
					isPlaying: nextIsPlaying,
					cover: remoteCoverUrl || null,
				},
			});
		};

		function onBody(payload: WSPayload) {
			if (payload.type === "ping") {
				invoke("ws_broadcast_payload", { payload: { type: "pong" } });
				return;
			}

			if (payload.type !== "state") {
				return;
			}

			if (isLyricOnly) {
				const isLyricUpdate =
					payload.value.update === "setLyric" ||
					payload.value.update === "setMusic";
				if (!isLyricUpdate) {
					return;
				}
			}

			const state = payload.value;
			switch (state.update) {
				case "setMusic": {
					store.set(musicIdAtom, state.musicId);
					store.set(musicNameAtom, state.musicName);
					store.set(musicAlbumNameAtom, state.albumName);
					store.set(musicDurationAtom, state.duration);
					store.set(
						musicArtistsAtom,
						state.artists.map((v) => ({ id: v.id, name: v.name })),
					);
					store.set(musicPlayingPositionAtom, 0);

					const artistNames = state.artists.map((v) => v.name).join(" / ");
					invoke("update_remote_now_playing", {
						info: {
							title: state.musicName,
							artist: artistNames,
							album: state.albumName,
							isPlaying: store.get(musicPlayingAtom),
							cover: remoteCoverUrl || null,
						},
					});
					break;
				}
				case "setCover": {
					if (curCoverBlobUrl) {
						URL.revokeObjectURL(curCoverBlobUrl);
						curCoverBlobUrl = "";
					}

					if (state.source === "uri") {
						store.set(musicCoverAtom, state.url);
						remoteCoverUrl = state.url;
					} else {
						const { mimeType, data: base64Data } = state.image;
						const binaryString = atob(base64Data);
						const bytes = new Uint8Array(binaryString.length);
						for (let i = 0; i < binaryString.length; i++) {
							bytes[i] = binaryString.charCodeAt(i);
						}
						const blob = new Blob([bytes], { type: mimeType });

						const url = URL.createObjectURL(blob);
						curCoverBlobUrl = url;
						store.set(musicCoverAtom, url);
						remoteCoverUrl = `data:${mimeType};base64,${base64Data}`;
					}
					emitRemoteNowPlaying(store.get(musicPlayingAtom));
					break;
				}
				case "setLyric": {
					let lines: WSLyricLine[];
					if (state.format === "structured") {
						lines = state.lines;
					} else {
						try {
							lines = parseTTML(state.data).lines;
						} catch (e) {
							console.error(e);
							toast.error(
								t(
									"ws-protocol.toast.ttmlParseError",
									"解析来自 WS 发送端的 TTML 歌词时出错：{{error}}",
									{ error: String(e) },
								),
							);
							return;
						}
					}
					const processed = lines.map((line) => ({
						...line,
						words: line.words.map((word) => ({ ...word, obscene: false })),
					}));
					store.set(hideLyricViewAtom, processed.length === 0);
					store.set(musicLyricLinesAtom, processed);
					break;
				}
				case "progress": {
					store.set(musicPlayingPositionAtom, state.progress);
					break;
				}
				case "volume": {
					store.set(musicVolumeAtom, state.volume);
					break;
				}
				case "paused": {
					store.set(musicPlayingAtom, false);
					emitRemoteNowPlaying(false);
					break;
				}
				case "resumed": {
					store.set(musicPlayingAtom, true);
					emitRemoteNowPlaying(true);
					break;
				}
				case "audioData": {
					lastWsAudioDataAt.current = Date.now();
					if (isSystemAudioActive.current) {
						stopSystemAudio();
					}
					fftPlayer.current?.pushDataI16(
						48000,
						2,
						new Int16Array(new Uint8Array(state.data).buffer),
					);
					break;
				}
				case "modeChanged": {
					store.set(repeatModeAtom, state.repeat);
					store.set(isShuffleActiveAtom, state.shuffle);
					break;
				}
				default:
					console.log(
						"on-ws-protocol-client-body",
						"未处理的报文（暂不支持）",
						payload,
					);
			}
		}

		onBodyChannel.onmessage = onBody;

		// const unlistenBody = listen("on-ws-protocol-client-body", onBody);
		const unlistenDisconnected = listen<string>(
			"on-ws-protocol-client-disconnected",
			(evt) =>
				setConnectedAddrs(
					(prev) => new Set([...prev].filter((v) => v !== evt.payload)),
				),
		);
		invoke<string[]>("ws_get_connections").then((addrs) =>
			setConnectedAddrs(new Set(addrs)),
		);
		invoke("ws_close_connection").then(() => {
			const addr = wsProtocolListenAddr || "127.0.0.1:11444";
			invoke("ws_reopen_connection", { addr, channel: onBodyChannel });
		});
		return () => {
			unlistenConnected.then((u) => u());
			unlistenRemoteHttp.then((u) => u());
			unlistenRemotePlaySong.then((u) => u());
			unlistenRemoteFullscreen.then((u) => u());
			unlistenRemoteAlwaysOnTop.then((u) => u());
			unlistenDisconnected.then((u) => u());

			invoke("ws_close_connection");

			const doNothing = { onEmit: () => {} };
			store.set(onRequestNextSongAtom, doNothing);
			store.set(onRequestPrevSongAtom, doNothing);
			store.set(onPlayOrResumeAtom, doNothing);
			store.set(onSeekPositionAtom, doNothing);
			store.set(onLyricLineClickAtom, doNothing);
			store.set(onChangeVolumeAtom, doNothing);
			store.set(onClickControlThumbAtom, doNothing);
			store.set(onToggleShuffleAtom, doNothing);
			store.set(onCycleRepeatModeAtom, doNothing);

			if (curCoverBlobUrl) {
				URL.revokeObjectURL(curCoverBlobUrl);
				curCoverBlobUrl = "";
			}

			if (!isLyricOnly) {
				store.set(musicNameAtom, "");
				store.set(musicAlbumNameAtom, "");
				store.set(musicCoverAtom, "");
				store.set(musicArtistsAtom, []);
				store.set(musicIdAtom, "");
				store.set(musicDurationAtom, 0);
				store.set(musicPlayingPositionAtom, 0);
				store.set(musicPlayingAtom, false);
				store.set(musicLyricLinesAtom, []);
				store.set(musicVolumeAtom, 1);
			}
		};
	}, [
		wsProtocolListenAddr,
		setConnectedAddrs,
		store,
		t,
		isLyricOnly,
		setIsLyricPageOpened,
		stopSystemAudio,
	]);

	if (isLyricOnly) {
		return null;
	}

	return <FFTToLowPassContext />;
};
