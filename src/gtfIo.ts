// Copyright (C) 2026 Oliver Slay and Simon Andrews
// SPDX-License-Identifier: GPL-3.0-only

// Runs the GTF parse in a worker so a multi-GB file doesn't freeze the UI thread.
import type { ExonGene } from "./types";
import type { GtfWorkerRequest, GtfWorkerResponse } from "./gtfTypes";

export interface GtfParseCallbacks {
    onProgress?: (fraction: number) => void;
    // Called repeatedly as finished genes stream back, rather than once at the end,
    // so the caller can build its index incrementally instead of holding a second
    // full copy of the result alongside the one it's building.
    onGenes: (genes: ExonGene[]) => void;
}

export async function parseGtfFile(file: File, maxTsl: number | null, callbacks: GtfParseCallbacks): Promise<number> {
    const worker = new Worker(new URL("./gtfWorker.ts", import.meta.url), { type: "module" });
    try {
        return await new Promise<number>((resolve, reject) => {
            worker.onmessage = (e: MessageEvent<GtfWorkerResponse>) => {
                const msg = e.data;
                if (msg.type === "progress") {
                    if (callbacks.onProgress && msg.totalBytes > 0) callbacks.onProgress(msg.bytesRead / msg.totalBytes);
                } else if (msg.type === "genes") {
                    callbacks.onGenes(msg.genes);
                } else if (msg.type === "done") {
                    resolve(msg.totalGenes);
                } else {
                    reject(new Error(msg.message));
                }
            };
            worker.onerror = (e) => reject(new Error(e.message || "GTF worker failed"));
            const request: GtfWorkerRequest = { file, maxTsl };
            worker.postMessage(request);
        });
    } finally {
        worker.terminate();
    }
}
