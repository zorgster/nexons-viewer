// Copyright (C) 2026 Oliver Slay and Simon Andrews
// SPDX-License-Identifier: GPL-3.0-only

export interface ExonTranscript {
    id: string;
    name: string;
    start: number; // 1-based, from the GTF
    end: number;
    exons: [number, number][]; // 1-based [start,end], inclusive
    isMane?: boolean; // carries the MANE_Select tag - absent/false for a pre-built JSON that predates this field
}

export interface ExonGene {
    id: string;
    name: string;
    chrom: string;
    start: number; // 1-based
    end: number;
    strand: string;
    transcripts: ExonTranscript[];
}

export type CigarOp = [string, number];

export type BamTags = Record<string, string | number | null | undefined>;

export interface BamRecord {
    refID: number;
    chrom: string | null;
    pos: number; // 0-based
    flag: number;
    mapq: number;
    readName: string;
    cigar: CigarOp[];
    tags: BamTags;
    isUnmapped: boolean;
    isSecondary: boolean;
    isReverse: boolean;
    start: number; // 0-based, same as pos
    end: number;   // 0-based, exclusive - end of the last aligned block
    blocks: [number, number][]; // 0-based [start,end) reference-consuming blocks, split at N
}

export interface BaiChunk {
    begin: bigint; // virtual file offset
    end: bigint;
}

export interface BaiRefIndex {
    bins: Map<number, BaiChunk[]>;
    linearIndex: bigint[];
}

export interface BamHeader {
    refNames: string[];
}

export interface BamHandle {
    file: File;
    refNames: string[];
    chromToRefID: Map<string, number>;
    refIndex: BaiRefIndex[];
}
