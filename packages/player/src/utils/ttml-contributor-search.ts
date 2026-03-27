import { parseTTML } from "@applemusic-like-lyrics/lyric";

export interface LyricMatchResult {
	contributor: string | null;
	matchedFile: string | null;
}

const TTML_DB_BASE_URL = "https://amll-ttml-db.gbclstudio.cn/ncm-lyrics";

const contributorCache = new Map<string, string | null>();

export async function fetchLyricContributorByNCMId(
	ncmId: string,
): Promise<LyricMatchResult> {
	if (!ncmId || typeof ncmId !== "string") {
		return { contributor: null, matchedFile: null };
	}

	if (contributorCache.has(ncmId)) {
		return {
			contributor: contributorCache.get(ncmId) ?? null,
			matchedFile: `${ncmId}.ttml`,
		};
	}

	try {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 5000);

		const response = await fetch(`${TTML_DB_BASE_URL}/${ncmId}.ttml`, {
			method: "GET",
			signal: controller.signal,
		});

		clearTimeout(timeoutId);

		if (!response.ok) {
			contributorCache.set(ncmId, null);
			return { contributor: null, matchedFile: null };
		}

		const ttmlText = await response.text();

		if (!ttmlText || ttmlText.length === 0) {
			contributorCache.set(ncmId, null);
			return { contributor: null, matchedFile: null };
		}

		let ttmlResult;
		try {
			ttmlResult = parseTTML(ttmlText);
		} catch (parseError) {
			console.error("解析TTML失败:", parseError);
			contributorCache.set(ncmId, null);
			return { contributor: null, matchedFile: null };
		}

		const lines = ttmlResult?.lines;
		if (!lines || !Array.isArray(lines)) {
			contributorCache.set(ncmId, null);
			return { contributor: null, matchedFile: null };
		}

		const hasWordLyrics = lines.some(
			(line) => line && Array.isArray(line.words) && line.words.length > 0,
		);

		if (!hasWordLyrics) {
			contributorCache.set(ncmId, null);
			return { contributor: null, matchedFile: null };
		}

		const metadata = ttmlResult?.metadata;
		let contributor: string | null = null;

		if (metadata && Array.isArray(metadata)) {
			const authorMeta = metadata.find(
				([key]) => key === "ttmlAuthorGithubLogin",
			);
			contributor = authorMeta?.[1]?.[0] ?? null;
		}

		contributorCache.set(ncmId, contributor);

		return {
			contributor,
			matchedFile: `${ncmId}.ttml`,
		};
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			console.warn("获取歌词贡献者超时:", ncmId);
		} else {
			console.error("获取歌词贡献者时出错:", error);
		}
		contributorCache.set(ncmId, null);
		return { contributor: null, matchedFile: null };
	}
}

export function invalidateContributorCache(): void {
	contributorCache.clear();
}

export async function findLyricContributor(
	_songName: string,
	_artistName: string,
): Promise<LyricMatchResult> {
	return { contributor: null, matchedFile: null };
}

export async function findLyricContributorBySong(
	_songName: string,
	_artists: string[],
): Promise<LyricMatchResult> {
	return { contributor: null, matchedFile: null };
}
