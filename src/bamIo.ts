// Copyright (C) 2026 Oliver Slay and Simon Andrews
// SPDX-License-Identifier: GPL-3.0-only

// BAM/BGZF/BAI utilities: indexed, on-demand region queries against a local
// BAM + BAI file pair, no server involved. Runs on the main thread - each
// region query only decompresses a handful of BGZF blocks (KBs, not the
// whole file).
import { inflate } from "pako";
import type { BaiChunk, BaiRefIndex, BamHeader, BamRecord, CigarOp } from "./types";

const CIGAR_OPS = ["M", "I", "D", "N", "S", "H", "P", "=", "X"];
const AUX_SIZES: Record<string, number> = { c: 1, C: 1, s: 2, S: 2, i: 4, I: 4, f: 4 };
const MAX_BGZF_BLOCK = 65536; // BSIZE is a uint16, so a block (header+payload+footer) is at most 65536 bytes

// -------------------------------------------------------------------
// BGZF decompression: prefer the browser's native DecompressionStream
// (real zlib) over pako's pure-JS inflate, validated against a byte
// count computed from a cheap header-only scan; fall back to pako if
// native is unavailable or wrong.
// -------------------------------------------------------------------

interface BGZFBlockInfo {
    offset: number;
    blockLen: number;
    isize: number;
}

function scanBGZFHeaders(bytes: Uint8Array): BGZFBlockInfo[] {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const blocks: BGZFBlockInfo[] = [];
    let offset = 0;

    while (offset + 18 <= bytes.length) {
        if (bytes[offset] !== 31 || bytes[offset + 1] !== 139) {
            throw new Error("Not a valid BGZF block at byte offset " + offset);
        }
        const xlen = view.getUint16(offset + 10, true);
        let bsize: number | null = null;
        let subOff = offset + 12;
        const subEnd = subOff + xlen;
        while (subOff < subEnd) {
            const si1 = bytes[subOff];
            const si2 = bytes[subOff + 1];
            const slen = view.getUint16(subOff + 2, true);
            if (si1 === 66 && si2 === 67) bsize = view.getUint16(subOff + 4, true); // 'B','C'
            subOff += 4 + slen;
        }
        if (bsize === null) {
            throw new Error("BGZF block missing BSIZE subfield at byte offset " + offset);
        }
        const blockLen = bsize + 1;
        if (offset + blockLen > bytes.length) break; // final block truncated in this window - caller may retry with more data
        const isize = view.getUint32(offset + blockLen - 4, true);
        blocks.push({ offset, blockLen, isize });
        offset += blockLen;
    }

    return blocks;
}

async function nativeDecompressAll(bytes: Uint8Array): Promise<Uint8Array> {
    const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.length;
    }
    const result = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) { result.set(c, pos); pos += c.length; }
    return result;
}

function pakoDecompressBlocks(bytes: Uint8Array, blocks: BGZFBlockInfo[]): Uint8Array {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (const b of blocks) {
        const member = bytes.subarray(b.offset, b.offset + b.blockLen);
        const inflated = inflate(member);
        if (inflated.length > 0) chunks.push(inflated);
        total += inflated.length;
    }
    const result = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) { result.set(c, pos); pos += c.length; }
    return result;
}

async function decompressBGZF(bytes: Uint8Array): Promise<Uint8Array> {
    const blocks = scanBGZFHeaders(bytes);
    const expectedSize = blocks.reduce((s, b) => s + b.isize, 0);

    if (typeof DecompressionStream !== "undefined") {
        try {
            const native = await nativeDecompressAll(bytes);
            if (native.length === expectedSize) return native;
            console.warn(`Native gzip decompression gave ${native.length} bytes, expected ${expectedSize} - falling back to pako`);
        } catch (err) {
            console.warn("Native gzip decompression failed, falling back to pako", err);
        }
    }

    return pakoDecompressBlocks(bytes, blocks);
}

// -------------------------------------------------------------------
// BAM record parsing
// -------------------------------------------------------------------

function readCString(data: Uint8Array, p: number): [string, number] {
    let s = "";
    while (data[p] !== 0) { s += String.fromCharCode(data[p]); p++; }
    return [s, p + 1];
}

// Parses one BAM alignment record starting at byte `offset` in `data`.
// Returns null if the record isn't fully present (truncated at the end of `data`).
function parseOneRecord(data: Uint8Array, offset: number, refNames: string[]): [BamRecord, number] | null {
    if (offset + 4 > data.length) return null;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const blockSize = view.getInt32(offset, true);
    const recStart = offset + 4;
    const recEnd = recStart + blockSize;
    if (recEnd > data.length) return null;

    const refID = view.getInt32(recStart, true);
    const pos = view.getInt32(recStart + 4, true); // 0-based
    const lReadName = data[recStart + 8];
    const mapq = data[recStart + 9];
    const nCigarOp = view.getUint16(recStart + 12, true);
    const flag = view.getUint16(recStart + 14, true);
    const lSeq = view.getUint32(recStart + 16, true);

    let p = recStart + 32;
    let readName = "";
    for (let j = 0; j < lReadName - 1; j++) readName += String.fromCharCode(data[p + j]);
    p += lReadName;

    const cigar: CigarOp[] = [];
    for (let c = 0; c < nCigarOp; c++) {
        const val = view.getUint32(p, true); p += 4;
        cigar.push([CIGAR_OPS[val & 0xF], val >>> 4]);
    }

    p += (lSeq + 1) >> 1; // seq - skip
    p += lSeq;            // qual - skip

    const tags: Record<string, string | number | null> = {};
    while (p < recEnd) {
        const tag = String.fromCharCode(data[p], data[p + 1]); p += 2;
        const type = String.fromCharCode(data[p]); p += 1;
        let value: string | number | null;
        if (type === "A") { value = String.fromCharCode(data[p]); p += 1; }
        else if (type === "c") { value = view.getInt8(p); p += 1; }
        else if (type === "C") { value = view.getUint8(p); p += 1; }
        else if (type === "s") { value = view.getInt16(p, true); p += 2; }
        else if (type === "S") { value = view.getUint16(p, true); p += 2; }
        else if (type === "i") { value = view.getInt32(p, true); p += 4; }
        else if (type === "I") { value = view.getUint32(p, true); p += 4; }
        else if (type === "f") { value = view.getFloat32(p, true); p += 4; }
        else if (type === "Z" || type === "H") { const [s, np] = readCString(data, p); value = s; p = np; }
        else if (type === "B") {
            const subtype = String.fromCharCode(data[p]); p += 1;
            const count = view.getUint32(p, true); p += 4;
            p += count * (AUX_SIZES[subtype] || 1);
            value = null;
        } else {
            break; // unknown tag type - can't safely keep parsing this record's aux block
        }
        tags[tag] = value;
    }

    const blocks = cigarToBlocks(pos, cigar);
    const end = blocks.length ? blocks[blocks.length - 1][1] : pos;

    const record: BamRecord = {
        refID,
        chrom: refID >= 0 ? refNames[refID] : null,
        pos,
        flag,
        mapq,
        readName,
        cigar,
        tags,
        isUnmapped: (flag & 0x4) !== 0,
        isSecondary: (flag & 0x100) !== 0,
        isReverse: (flag & 0x10) !== 0,
        start: pos,
        end,
        blocks,
    };

    return [record, recEnd];
}

export function cigarToBlocks(pos0: number, cigar: CigarOp[]): [number, number][] {
    const blocks: [number, number][] = [];
    let start = pos0;
    let cur = pos0;
    for (const [op, len] of cigar) {
        if (op === "M" || op === "=" || op === "X" || op === "D") {
            cur += len;
        } else if (op === "N") {
            if (cur > start) blocks.push([start, cur]);
            cur += len;
            start = cur;
        }
    }
    if (cur > start) blocks.push([start, cur]);
    return blocks;
}

export function cigarString(cigar: CigarOp[]): string {
    return cigar.map(([op, len]) => `${len}${op}`).join("");
}

// -------------------------------------------------------------------
// BAM header (magic + text + ref names) - read just enough of the file
// to parse this, growing the read window if the header spans more bytes
// than first guessed.
// -------------------------------------------------------------------

function tryParseHeader(data: Uint8Array): BamHeader | null {
    if (data.length < 8) return null;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const magic = String.fromCharCode(data[0], data[1], data[2], data[3]);
    if (magic !== "BAM\x01") throw new Error("Not a BAM file (bad magic bytes)");

    let offset = 4;
    if (offset + 4 > data.length) return null;
    const lText = view.getInt32(offset, true); offset += 4;
    if (offset + lText > data.length) return null;
    offset += lText;

    if (offset + 4 > data.length) return null;
    const nRef = view.getInt32(offset, true); offset += 4;
    const refNames: string[] = [];
    for (let i = 0; i < nRef; i++) {
        if (offset + 4 > data.length) return null;
        const lName = view.getInt32(offset, true); offset += 4;
        if (offset + lName + 4 > data.length) return null;
        let name = "";
        for (let j = 0; j < lName - 1; j++) name += String.fromCharCode(data[offset + j]);
        offset += lName;
        offset += 4; // l_ref
        refNames.push(name);
    }

    return { refNames };
}

export async function parseBAMHeader(file: File): Promise<BamHeader> {
    let windowSize = Math.min(file.size, 1 << 20); // start at 1MB
    const maxWindow = 1 << 26; // 64MB cap

    while (true) {
        const raw = new Uint8Array(await file.slice(0, windowSize).arrayBuffer());
        try {
            const data = await decompressBGZF(raw);
            const result = tryParseHeader(data);
            if (result) return result;
        } catch (err) {
            if (windowSize >= maxWindow || windowSize >= file.size) throw err;
        }
        if (windowSize >= maxWindow || windowSize >= file.size) {
            throw new Error(`Could not parse BAM header within ${maxWindow} bytes`);
        }
        windowSize = Math.min(windowSize * 2, file.size);
    }
}

// -------------------------------------------------------------------
// BAI parsing and region queries
// -------------------------------------------------------------------

export async function readBAI(file: File): Promise<BaiRefIndex[]> {
    const data = new Uint8Array(await file.arrayBuffer());
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    const magic = String.fromCharCode(data[0], data[1], data[2], data[3]);
    if (magic !== "BAI\x01") throw new Error("Not a valid BAI file (bad magic bytes)");

    let offset = 4;
    const nRef = view.getInt32(offset, true); offset += 4;
    const refs: BaiRefIndex[] = [];

    for (let i = 0; i < nRef; i++) {
        const nBin = view.getInt32(offset, true); offset += 4;
        const bins = new Map<number, BaiChunk[]>();
        for (let b = 0; b < nBin; b++) {
            const binNum = view.getUint32(offset, true); offset += 4;
            const nChunk = view.getInt32(offset, true); offset += 4;
            const chunks: BaiChunk[] = [];
            for (let c = 0; c < nChunk; c++) {
                const begin = view.getBigUint64(offset, true); offset += 8;
                const end = view.getBigUint64(offset, true); offset += 8;
                chunks.push({ begin, end });
            }
            bins.set(binNum, chunks);
        }
        const nIntv = view.getInt32(offset, true); offset += 4;
        const linearIndex: bigint[] = [];
        for (let v = 0; v < nIntv; v++) {
            linearIndex.push(view.getBigUint64(offset, true)); offset += 8;
        }
        refs.push({ bins, linearIndex });
    }

    return refs;
}

// Standard SAM/BAI binning scheme (htslib reg2bins), 0-based half-open [beg,end)
function reg2bins(beg: number, end: number): number[] {
    end -= 1;
    const list = [0];
    for (let k = 1 + (beg >> 26); k <= 1 + (end >> 26); k++) list.push(k);
    for (let k = 9 + (beg >> 23); k <= 9 + (end >> 23); k++) list.push(k);
    for (let k = 73 + (beg >> 20); k <= 73 + (end >> 20); k++) list.push(k);
    for (let k = 585 + (beg >> 17); k <= 585 + (end >> 17); k++) list.push(k);
    for (let k = 4681 + (beg >> 14); k <= 4681 + (end >> 14); k++) list.push(k);
    return list;
}

function chunksForRegion(refIndex: BaiRefIndex, beg: number, end: number): BaiChunk[] {
    const bins = reg2bins(beg, end);
    let chunks: BaiChunk[] = [];
    for (const bin of bins) {
        const binChunks = refIndex.bins.get(bin);
        if (binChunks) chunks.push(...binChunks);
    }

    const win = beg >> 14;
    let minOffset = 0n;
    if (refIndex.linearIndex.length > 0) {
        const idx = Math.min(win, refIndex.linearIndex.length - 1);
        minOffset = refIndex.linearIndex[idx];
    }
    chunks = chunks.filter((c) => c.end > minOffset);
    chunks.sort((a, b) => (a.begin < b.begin ? -1 : a.begin > b.begin ? 1 : 0));
    return chunks;
}

// Fetches and parses every record overlapping [beg,end) on refID, using the
// BAI to only touch the relevant BGZF blocks. Some over-fetching (reads
// from other regions within the same blocks) and rare duplicate records
// across overlapping chunks are possible; duplicates are removed below,
// and stray out-of-region reads are filtered by the caller via refID+overlap.
export async function fetchRegionRecords(
    bamFile: File,
    refIndex: BaiRefIndex,
    refID: number,
    beg: number,
    end: number,
    refNames: string[],
): Promise<BamRecord[]> {
    const chunks = chunksForRegion(refIndex, beg, end);
    const fileSize = bamFile.size;
    const records: BamRecord[] = [];

    for (const { begin: chunkBeg, end: chunkEnd } of chunks) {
        const coffsetStart = Number(chunkBeg >> 16n);
        const uoffsetStart = Number(chunkBeg & 0xFFFFn);
        const coffsetEndBlockStart = Number(chunkEnd >> 16n);
        const readEnd = Math.min(fileSize, coffsetEndBlockStart + MAX_BGZF_BLOCK);

        const raw = new Uint8Array(await bamFile.slice(coffsetStart, readEnd).arrayBuffer());
        let data: Uint8Array;
        try {
            data = await decompressBGZF(raw);
        } catch (err) {
            console.warn("Skipping unreadable BGZF chunk", err);
            continue;
        }

        let recordOffset = uoffsetStart;
        while (recordOffset < data.length) {
            const parsed = parseOneRecord(data, recordOffset, refNames);
            if (!parsed) break; // record not fully present in this window
            const [rec, nextOffset] = parsed;
            recordOffset = nextOffset;

            if (rec.refID === refID && !rec.isUnmapped) {
                if (rec.pos < end && rec.end > beg) {
                    records.push(rec);
                }
            }
        }
    }

    const seen = new Set<string>();
    const deduped: BamRecord[] = [];
    for (const r of records) {
        const key = `${r.readName}|${r.pos}|${r.flag}`;
        if (!seen.has(key)) { seen.add(key); deduped.push(r); }
    }
    return deduped;
}
