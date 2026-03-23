import type { TTMLLyric } from "@applemusic-like-lyrics/lyric";
import chalk from "chalk";
import { db } from "../dexie";

const TTML_LOG_TAG = chalk.bgHex("#FF5577").hex("#FFFFFF")(" TTML DB ");

export interface LyricMatchResult {
	contributor: string | null;
	matchedFile: string | null;
}

function normalizeString(str: string): string {
	return str
		.toLowerCase()
		.replace(/[^\w\s\u4e00-\u9fff]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function extractMetadataValue(
	metadata: [string, string[]][] | undefined,
	key: string,
): string | null {
	if (!metadata) return null;
	const entry = metadata.find(([k]) => k === key);
	return entry?.[1]?.[0] ?? null;
}

function matchScore(
	ttmlLyric: TTMLLyric,
	songName: string,
	artistName: string,
): number {
	const metaMusicName = extractMetadataValue(ttmlLyric.metadata, "musicName");
	const metaArtists = extractMetadataValue(ttmlLyric.metadata, "artists");

	if (!metaMusicName || !metaArtists) return 0;

	const normalizedMetaName = normalizeString(metaMusicName);
	const normalizedMetaArtists = normalizeString(metaArtists);
	const normalizedSongName = normalizeString(songName);
	const normalizedArtistName = normalizeString(artistName);

	const nameMatch =
		normalizedMetaName === normalizedSongName ||
		normalizedMetaName.includes(normalizedSongName) ||
		normalizedSongName.includes(normalizedMetaName);

	const artistMatch =
		normalizedMetaArtists === normalizedArtistName ||
		normalizedMetaArtists.includes(normalizedArtistName) ||
		normalizedArtistName.includes(normalizedMetaArtists);

	if (nameMatch && artistMatch) return 100;
	if (nameMatch) return 50;
	if (artistMatch) return 25;

	return 0;
}

export async function findLyricContributor(
	songName: string,
	artistName: string,
): Promise<LyricMatchResult> {
	try {
		const allEntries = await db.ttmlDB.toArray();

		if (allEntries.length === 0) {
			console.log(TTML_LOG_TAG, "TTML 数据库为空，无法查询贡献者");
			return { contributor: null, matchedFile: null };
		}

		let bestMatch: { entry: (typeof allEntries)[0]; score: number } | null =
			null;

		for (const entry of allEntries) {
			const score = matchScore(entry.content, songName, artistName);
			if (score > (bestMatch?.score ?? 0)) {
				bestMatch = { entry, score };
			}
		}

		if (bestMatch && bestMatch.score >= 50) {
			const contributor = extractMetadataValue(
				bestMatch.entry.content.metadata,
				"ttmlAuthorGithubLogin",
			);
			console.log(
				TTML_LOG_TAG,
				`匹配到歌词: ${bestMatch.entry.name}, 贡献者: ${contributor}, 匹配分数: ${bestMatch.score}`,
			);
			return {
				contributor,
				matchedFile: bestMatch.entry.name,
			};
		}

		console.log(
			TTML_LOG_TAG,
			`未找到匹配的歌词: "${songName}" - "${artistName}"`,
		);
		return { contributor: null, matchedFile: null };
	} catch (error) {
		console.error(TTML_LOG_TAG, "查询歌词贡献者时出错:", error);
		return { contributor: null, matchedFile: null };
	}
}

export async function findLyricContributorBySong(
	songName: string,
	artists: string[],
): Promise<LyricMatchResult> {
	const artistName = artists.join(", ");
	return findLyricContributor(songName, artistName);
}
