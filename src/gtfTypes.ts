// Copyright (C) 2026 Oliver Slay and Simon Andrews
// SPDX-License-Identifier: GPL-3.0-only

import type { ExonGene } from "./types";

export interface GtfWorkerRequest {
    file: File;
    maxTsl: number | null; // null = no filter; otherwise keep transcripts with TSL 1..maxTsl
}

export interface GtfWorkerProgress {
    type: "progress";
    bytesRead: number;
    totalBytes: number;
}

// Finished genes are streamed back in small batches as they're parsed, rather than
// as one giant array at the end, so the main thread never has to structured-clone
// the whole result in a single copy.
export interface GtfWorkerGenes {
    type: "genes";
    genes: ExonGene[];
}

export interface GtfWorkerDone {
    type: "done";
    totalGenes: number;
}

export interface GtfWorkerError {
    type: "error";
    message: string;
}

export type GtfWorkerResponse = GtfWorkerProgress | GtfWorkerGenes | GtfWorkerDone | GtfWorkerError;
