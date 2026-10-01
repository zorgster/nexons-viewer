// Copyright (C) 2026 Oliver Slay and Simon Andrews
// SPDX-License-Identifier: GPL-3.0-only

import type { BamRecord, ExonTranscript } from "./types";

export type TranscriptSortMode = "name" | "readCount";

export function compareTranscriptsByName(a: ExonTranscript, b: ExonTranscript): number {
    if (!!a.isMane !== !!b.isMane) return a.isMane ? -1 : 1;
    return a.id.localeCompare(b.id);
}

function assignedReadCounts(transcripts: ExonTranscript[], records: BamRecord[]): Map<string, number> {
    const counts = new Map(transcripts.map((transcript) => [transcript.id, 0]));
    for (const record of records) {
        const transcriptId = typeof record.tags.nT === "string" ? record.tags.nT : null;
        if (transcriptId && counts.has(transcriptId)) {
            counts.set(transcriptId, counts.get(transcriptId)! + 1);
        }
    }
    return counts;
}

export function transcriptsMeetingMinimumReadCount(
    transcripts: ExonTranscript[],
    panelRecords: BamRecord[][],
    minimumReadCount: number,
): string[] {
    if (minimumReadCount <= 0) return transcripts.map((transcript) => transcript.id);

    const visibleIds = new Set<string>();
    for (const records of panelRecords) {
        const counts = assignedReadCounts(transcripts, records);
        for (const transcript of transcripts) {
            if (counts.get(transcript.id)! >= minimumReadCount) visibleIds.add(transcript.id);
        }
    }
    return transcripts.filter((transcript) => visibleIds.has(transcript.id)).map((transcript) => transcript.id);
}

export function sortTranscriptsByReadCount(
    transcripts: ExonTranscript[],
    records: BamRecord[],
): ExonTranscript[] {
    const counts = assignedReadCounts(transcripts, records);
    return [...transcripts].sort((a, b) =>
        counts.get(b.id)! - counts.get(a.id)! || compareTranscriptsByName(a, b),
    );
}

export function rankTranscriptsAcrossPanels(
    transcripts: ExonTranscript[],
    panelRecords: BamRecord[][],
): string[] {
    if (panelRecords.length === 0) {
        return [...transcripts].sort(compareTranscriptsByName).map((transcript) => transcript.id);
    }

    const rankTotals = new Map(transcripts.map((transcript) => [transcript.id, 0]));

    for (const records of panelRecords) {
        const counts = assignedReadCounts(transcripts, records);
        const ranked = [...transcripts].sort((a, b) =>
            counts.get(b.id)! - counts.get(a.id)! || compareTranscriptsByName(a, b),
        );

        // Transcripts with the same count share the mean of their occupied rank positions.
        for (let start = 0; start < ranked.length;) {
            let end = start + 1;
            while (end < ranked.length && counts.get(ranked[end].id) === counts.get(ranked[start].id)) end++;
            const tiedRank = (start + end - 1) / 2;
            for (let i = start; i < end; i++) {
                rankTotals.set(ranked[i].id, rankTotals.get(ranked[i].id)! + tiedRank);
            }
            start = end;
        }
    }

    return [...transcripts]
        .sort((a, b) => rankTotals.get(a.id)! - rankTotals.get(b.id)! || compareTranscriptsByName(a, b))
        .map((transcript) => transcript.id);
}
