import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import styles from "./index.module.css";

interface LyricScrollProps {
	text: string;
	status: "primary" | "secondary";
	orientation: "horizontal" | "vertical";
	align: "left" | "right";
	startTime?: number;
	endTime?: number;
	nextStartTime?: number;
	isActive: boolean;
	isPlaying: boolean;
	getCurrentPosition: () => number;
	onProgress?: (progress: number) => void;
	subscribeProgress?: (callback: (progress: number) => void) => () => void;
}

export const LyricScroll = ({
	text,
	status,
	orientation,
	align,
	startTime,
	endTime,
	nextStartTime,
	isActive,
	isPlaying,
	getCurrentPosition,
	onProgress,
	subscribeProgress,
}: LyricScrollProps) => {
	const containerRef = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const [shouldScroll, setShouldScroll] = useState(false);
	const [maxTranslate, setMaxTranslate] = useState(0);
	const rafRef = useRef<number>(0);

	const isVert = orientation === "vertical";

	const measure = useCallback(() => {
		if (!containerRef.current || !contentRef.current) return;

		let overflow = 0;
		if (isVert) {
			overflow =
				contentRef.current.scrollHeight - containerRef.current.clientHeight;
		} else {
			overflow =
				contentRef.current.scrollWidth - containerRef.current.clientWidth;
		}

		if (overflow > 0 && text.trim().length > 0) {
			setShouldScroll(true);
			// 添加一些偏移量以便歌词能够滚动到右侧遮罩左边而不会滚动完了还会被遮罩挡住
			setMaxTranslate(overflow + 2);
		} else {
			setShouldScroll(false);
			setMaxTranslate(0);
			if (contentRef.current) {
				contentRef.current.style.transform = "none";
			}
		}
	}, [isVert, text]);

	useLayoutEffect(() => {
		measure();
	}, [measure]);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		const resizeObserver = new ResizeObserver(() => {
			measure();
		});

		resizeObserver.observe(container);
		if (contentRef.current) {
			resizeObserver.observe(contentRef.current);
		}
		return () => resizeObserver.disconnect();
	}, [measure]);

	const updateTranslate = useCallback(
		(progress: number) => {
			if (!contentRef.current) return;
			if (!shouldScroll) {
				contentRef.current.style.transform = "none";
				return;
			}

			const safeProgress = Math.max(0, Math.min(1, progress));

			let translation = -safeProgress * maxTranslate;
			if (!isVert && align === "right") {
				translation = safeProgress * maxTranslate;
			}
			if (isVert && align === "right") {
				translation = -safeProgress * maxTranslate;
			}

			contentRef.current.style.transform = isVert
				? `translateY(${translation}px)`
				: `translateX(${translation}px)`;
		},
		[shouldScroll, maxTranslate, isVert, align],
	);

	useEffect(() => {
		if (status !== "primary" || !isActive || !shouldScroll) return;

		const minDuration = 500;
		const sTime = startTime ?? 0;
		const eTime = endTime ?? nextStartTime;
		const duration = Math.max(minDuration, (eTime ?? sTime) - sTime);

		const loop = () => {
			if (!isActive) return;

			const pos = getCurrentPosition();
			let p = 0;

			if (pos >= sTime) {
				p = (pos - sTime) / duration;
			}

			updateTranslate(p);
			onProgress?.(p);

			if (isPlaying) {
				rafRef.current = requestAnimationFrame(loop);
			}
		};

		if (isPlaying) {
			rafRef.current = requestAnimationFrame(loop);
		} else {
			loop();
		}

		return () => {
			if (rafRef.current) {
				cancelAnimationFrame(rafRef.current);
			}
		};
	}, [
		status,
		isActive,
		shouldScroll,
		startTime,
		endTime,
		nextStartTime,
		isPlaying,
		getCurrentPosition,
		updateTranslate,
		onProgress,
	]);

	useEffect(() => {
		if (status === "secondary" && isActive && subscribeProgress) {
			const unsubscribe = subscribeProgress((progress: number) => {
				updateTranslate(progress);
			});
			return unsubscribe;
		}
	}, [status, isActive, subscribeProgress, updateTranslate]);

	useEffect(() => {
		if (!isActive && contentRef.current) {
			contentRef.current.style.transform = "none";
		}
	}, [isActive]);

	return (
		<div
			ref={containerRef}
			className={`${styles.scrollViewport} ${shouldScroll ? styles.canScroll : ""}`}
			data-align={align}
			data-orientation={orientation}
		>
			<div
				ref={contentRef}
				className={styles.scrollContent}
				data-align={align}
				data-orientation={orientation}
			>
				{text}
			</div>
		</div>
	);
};
