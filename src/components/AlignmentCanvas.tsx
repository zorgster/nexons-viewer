// Copyright (C) 2026 Oliver Slay and Simon Andrews
// SPDX-License-Identifier: GPL-3.0-only

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BamRecord, CigarOp, ExonGene, ExonTranscript } from "../types";
import {
    compareTranscriptsByName,
    sortTranscriptsByReadCount,
    transcriptsMeetingMinimumReadCount,
    type TranscriptSortMode,
} from "../transcriptSort";

// A stable reference (not a fresh `[]` literal per render) - ownPeaks below is memoized on
// this array's identity, and an unstable fallback would recompute it every render.
const EMPTY_TRANSCRIPTS: ExonTranscript[] = [];

// Read hue is semantic: green means the read is assigned to the currently displayed gene,
// purple means it is assigned to another single gene, and gray means multi-gene or no hit.
// Confidence (nR: unique/partial/gene/multi) is shown as fill *style* instead of hue - see
// drawConfidenceBlock.
const CURRENT_GENE_GREEN = "34,197,94";
const OTHER_GENE_PURPLE = "147,51,234";
const NEUTRAL_GRAY = "140,140,140";

function colorForRead(r: BamRecord, currentGene: ExonGene): string {
    const nR = typeof r.tags.nR === "string" ? r.tags.nR : undefined;
    if (nR !== "unique" && nR !== "partial" && nR !== "gene") return NEUTRAL_GRAY;

    const nG = typeof r.tags.nG === "string" ? r.tags.nG : undefined;
    if (!nG) return NEUTRAL_GRAY;
    return nG === currentGene.id || nG === currentGene.name ? CURRENT_GENE_GREEN : OTHER_GENE_PURPLE;
}

function isAnnotatedToGene(r: BamRecord, gene: ExonGene): boolean {
    const nG = typeof r.tags.nG === "string" ? r.tags.nG : undefined;
    return nG === gene.id || nG === gene.name;
}

function formatReadSuffix(readCount: number, totalReadCount: number): string {
    if (readCount === 0) return "";
    const percentage = totalReadCount > 0 ? (readCount / totalReadCount) * 100 : 0;
    const formattedPercentage = percentage >= 10
        ? Math.round(percentage).toString()
        : percentage.toFixed(1);
    return ` [${readCount.toLocaleString()} ${formattedPercentage}%]`;
}

// There's no genomics-standard color scheme for CIGAR text (the SAM spec defines the ops,
// not a visual convention), so this stays plain except for a muted tone on clipped bases -
// they're present in the read but not part of the reference alignment.
const CIGAR_OP_COLORS: Record<string, string> = {
    S: "#9aa5b1",
    H: "#9aa5b1",
};

function renderCigarSpans(cigar: CigarOp[]) {
    return cigar.map(([op, len], i) => (
        <span key={i} style={{ color: CIGAR_OP_COLORS[op] }}>{len}{op}</span>
    ));
}

const ROW_H = 6;
const ROW_GAP = 3;
const PX_GAP_MIN = 2;
const EXON_ROW_H = 10;
const GENE_ROW_H = 8;
const GENE_REGION_ROW_H = 8;
const MARGIN_L_MIN = 70;
const MARGIN_L_MAX = 220;
const MARGIN_R = 20;
const SEP_GAP = 6;
const LANE_INNER_GAP = 4;
const LANE_BOTTOM_GAP = 10;
const MIN_VIEW_BP = 30;
const KEYBOARD_PAN_FRACTION = 0.05;
const ZOOM_IN_FACTOR = 0.8;
const ZOOM_OUT_FACTOR = 1.25;
const CIGAR_DETAIL_MIN_PX_PER_BASE = 0.6;
const DENSITY_TRACK_H = 18;
const DENSITY_GAP = 2; // tight gap between a lane's density track and its exon-model row
const UNASSIGNED_ID = "__unassigned__";
const TOGGLE_GLYPH_W = 14;

type LaneViewMode = "transcript" | "reads" | "density";

type ScaleX = (g: number) => number;

interface PackedRead extends BamRecord { row: number }
interface PackedGeneItem { start: number; end: number; gene: ExonGene; row: number }

// The splice donor/acceptor positions a read uses (every block boundary except the very first
// start and very last end, which just reflect wherever a Nanopore read happened to get
// truncated). Two reads of the same isoform share this exactly, even with very different
// 5'/3' trimming, so it's what should cluster them - raw first-exon length does not.
function junctionKey(r: BamRecord): number[] {
    const key: number[] = [];
    for (let i = 0; i < r.blocks.length; i++) {
        if (i > 0) key.push(r.blocks[i][0]);
        if (i < r.blocks.length - 1) key.push(r.blocks[i][1]);
    }
    return key;
}

// Groups reads by shared splice-junction pattern first; within a group (same isoform, or all
// unspliced), the read with the longer first exon - i.e. the more complete 5' end - sorts to
// the top.
function compareByExonStructure(a: BamRecord, b: BamRecord): number {
    const ka = junctionKey(a);
    const kb = junctionKey(b);
    const maxLen = Math.max(ka.length, kb.length);
    for (let i = 0; i < maxLen; i++) {
        const va = ka[i];
        const vb = kb[i];
        if (va === undefined && vb === undefined) break;
        if (va === undefined) return 1;
        if (vb === undefined) return -1;
        if (va !== vb) return va - vb;
    }
    const lenA = a.blocks[0] ? a.blocks[0][1] - a.blocks[0][0] : 0;
    const lenB = b.blocks[0] ? b.blocks[0][1] - b.blocks[0][0] : 0;
    if (lenA !== lenB) return lenB - lenA;
    return a.start - b.start;
}

function packReads(reads: BamRecord[]): { reads: PackedRead[]; rowCount: number } {
    const sorted = [...reads].sort(compareByExonStructure) as PackedRead[];
    sorted.forEach((r, i) => {
        r.row = i;
    });
    return { reads: sorted, rowCount: sorted.length };
}

// Packs primary reads first (rows 0..N), then secondary reads below them (rows N..)
function layoutLane(reads: BamRecord[]) {
    const primary = reads.filter((r) => !r.isSecondary);
    const secondary = reads.filter((r) => r.isSecondary);
    const packedPrimary = packReads(primary);
    const packedSecondary = packReads(secondary);
    for (const r of packedSecondary.reads) r.row += packedPrimary.rowCount;
    return {
        reads: [...packedPrimary.reads, ...packedSecondary.reads],
        rowCount: packedPrimary.rowCount + packedSecondary.rowCount,
    };
}

function packGeneItems(items: { start: number; end: number; gene: ExonGene }[], scaleX: ScaleX) {
    const sorted = [...items].sort((a, b) => a.start - b.start) as PackedGeneItem[];
    const rowEndPx: number[] = [];
    for (const it of sorted) {
        const xStart = scaleX(it.start);
        const xEnd = scaleX(it.end);
        let placedRow = -1;
        for (let i = 0; i < rowEndPx.length; i++) {
            if (rowEndPx[i] <= xStart) { placedRow = i; break; }
        }
        if (placedRow === -1) { placedRow = rowEndPx.length; rowEndPx.push(0); }
        rowEndPx[placedRow] = xEnd + PX_GAP_MIN;
        it.row = placedRow;
    }
    return { items: sorted, rowCount: rowEndPx.length };
}

// Per-pixel-column read depth from each read's reference-consuming blocks (already split at
// N, so splice gaps don't count as covered). Secondary alignments are excluded so depth
// reflects actual coverage rather than being inflated by multi-mapping placements. This is
// only the shape drawn in the current viewport - the peak used to scale it is computed
// separately (see computeMaxDepth) so it stays stable across pan/zoom.
function computeCoverage(reads: BamRecord[], scaleX: ScaleX, pxFrom: number, pxTo: number): Float64Array {
    const n = Math.max(1, Math.ceil(pxTo - pxFrom));
    const delta = new Float64Array(n + 1);
    for (const r of reads) {
        if (r.isSecondary) continue;
        for (const [bStart, bEnd] of r.blocks) {
            const x1 = Math.max(pxFrom, scaleX(bStart));
            const x2 = Math.min(pxTo, scaleX(bEnd));
            if (x2 <= x1) continue;
            const i1 = Math.floor(x1 - pxFrom);
            // Preserve subpixel-wide covered regions by assigning them at least one full
            // density column. Adjacent regions may intentionally share that column.
            const i2 = Math.min(n, Math.max(i1 + 1, Math.ceil(x2 - pxFrom)));
            delta[i1] += 1;
            if (i2 < n) delta[i2] -= 1;
        }
    }
    const depth = new Float64Array(n);
    let running = 0;
    for (let i = 0; i < n; i++) {
        running += delta[i];
        depth[i] = running;
    }
    return depth;
}

// Exact max read depth (in base pairs, not pixels) across a lane's whole region - independent
// of pan/zoom and panel width, so the normalization scale doesn't shift as you navigate.
function computeMaxDepth(reads: BamRecord[]): number {
    const events: [number, number][] = [];
    for (const r of reads) {
        if (r.isSecondary) continue;
        for (const [bStart, bEnd] of r.blocks) {
            events.push([bStart, 1]);
            events.push([bEnd, -1]);
        }
    }
    events.sort((a, b) => a[0] - b[0] || a[1] - b[1]); // ends (-1) before starts (+1) at the same position
    let running = 0;
    let peak = 0;
    for (const [, delta] of events) {
        running += delta;
        if (running > peak) peak = running;
    }
    return peak;
}

// Fixed track height regardless of the lane's absolute depth (a peak of 3 and a peak of 3000
// both fill the band).
function drawDensityTrack(ctx: CanvasRenderingContext2D, pxFrom: number, depth: Float64Array, peak: number, trackY: number, trackH: number) {
    ctx.fillStyle = "rgba(37,99,235,0.55)";
    for (let i = 0; i < depth.length; i++) {
        if (depth[i] <= 0) continue;
        const h = peak > 0 ? Math.min(trackH, (depth[i] / peak) * trackH) : 0;
        ctx.fillRect(pxFrom + i, trackY + (trackH - h), 1, Math.max(1, h));
    }
    ctx.strokeStyle = "#d7dbe0";
    ctx.lineWidth = 1;
    ctx.strokeRect(pxFrom + 0.5, trackY + 0.5, Math.max(1, depth.length - 1), trackH - 1);
}

// Confidence (nR) is shown as fill style rather than hue, since hue is reserved for gene
// identity: "unique" is a solid block, "partial" is a light diagonal hatch, "gene" (matched
// only at the gene level, no specific transcript) is an outline with no fill, and "multi" /
// no-hit is a dotted gray outline since it isn't tied to one gene's color. Secondary alignments
// dim further and add a dashed border on top of whichever of these applies.
function drawConfidenceBlock(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, rgb: string, nR: string | undefined, isSecondary: boolean) {
    if (nR === "unique") {
        ctx.fillStyle = `rgba(${rgb},${isSecondary ? 0.35 : 1})`;
        ctx.fillRect(x, y, w, h);
        if (isSecondary) {
            ctx.strokeStyle = `rgb(${rgb})`;
            ctx.setLineDash([2, 2]);
            ctx.lineWidth = 1;
            ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, w - 1), h - 1);
            ctx.setLineDash([]);
        }
    } else if (nR === "partial") {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, w, h);
        ctx.clip();
        ctx.fillStyle = `rgba(${rgb},${isSecondary ? 0.12 : 0.22})`;
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = `rgba(${rgb},${isSecondary ? 0.5 : 0.9})`;
        ctx.lineWidth = 1;
        for (let sx = x - h; sx < x + w; sx += 4) {
            ctx.beginPath();
            ctx.moveTo(sx, y + h);
            ctx.lineTo(sx + h, y);
            ctx.stroke();
        }
        ctx.restore();
        ctx.strokeStyle = `rgba(${rgb},${isSecondary ? 0.5 : 0.9})`;
        ctx.lineWidth = 1;
        if (isSecondary) ctx.setLineDash([2, 2]);
        ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, w - 1), h - 1);
        ctx.setLineDash([]);
    } else if (nR === "gene") {
        ctx.strokeStyle = `rgba(${rgb},${isSecondary ? 0.55 : 0.95})`;
        ctx.lineWidth = 1.3;
        if (isSecondary) ctx.setLineDash([2, 2]);
        ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, w - 1), h - 1);
        ctx.setLineDash([]);
    } else {
        // "multi" (ambiguous across genes) or no hit at all - neutral gray, dotted
        ctx.fillStyle = `rgba(${rgb},${isSecondary ? 0.15 : 0.25})`;
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = `rgba(${rgb},${isSecondary ? 0.5 : 0.85})`;
        ctx.lineWidth = 1;
        ctx.setLineDash([1, 2]);
        ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, w - 1), h - 1);
        ctx.setLineDash([]);
    }
}

function drawReadRow(ctx: CanvasRenderingContext2D, r: PackedRead, rowY: number, scaleX: ScaleX, showCigarDetail: boolean, selected: boolean, currentGene: ExonGene, hitRects: HitRect[]) {
    const midY = rowY + ROW_H / 2;
    const rgb = colorForRead(r, currentGene);
    const nR = typeof r.tags.nR === "string" ? r.tags.nR : undefined;

    ctx.strokeStyle = `rgba(${rgb},${r.isSecondary ? 0.4 : 0.7})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(scaleX(r.start), midY);
    ctx.lineTo(scaleX(r.end), midY);
    ctx.stroke();

    for (const [bStart, bEnd] of r.blocks) {
        const x1 = scaleX(bStart);
        const x2 = scaleX(bEnd);
        const w = Math.max(1, x2 - x1);
        drawConfidenceBlock(ctx, x1, rowY, w, ROW_H, rgb, nR, r.isSecondary);
    }

    if (selected) {
        ctx.strokeStyle = "#000000";
        ctx.lineWidth = 2;
        ctx.setLineDash([]);
        for (const [bStart, bEnd] of r.blocks) {
            const x1 = scaleX(bStart);
            const x2 = scaleX(bEnd);
            ctx.strokeRect(x1 + 0.5, rowY + 0.5, Math.max(1, x2 - x1) - 1, ROW_H - 1);
        }
    }

    if (showCigarDetail) drawCigarDetail(ctx, r, scaleX, rowY);

    // A solid "unique" block is dark enough for a white arrow; the lighter/hollow styles need a
    // dark arrow instead to stay visible against the page background showing through.
    ctx.fillStyle = nR === "unique" ? "#ffffff" : "#374151";
    ctx.font = "9px monospace";
    const arrow = r.isReverse ? "‹" : "›";
    const cx = (scaleX(r.start) + scaleX(r.end)) / 2;
    if (scaleX(r.end) - scaleX(r.start) > 8) {
        ctx.fillText(arrow, cx - 2, midY + 3);
    }

    hitRects.push({ x1: scaleX(r.start), x2: scaleX(r.end), y1: rowY, y2: rowY + ROW_H, kind: "read", read: r });
}

// Evenly spaced chevrons along a bar showing which way the gene is transcribed, in the style
// of a genome browser's strand indicator - clipped to the visible plot area so a very wide or
// partly off-screen bar doesn't loop over off-canvas positions.
function drawStrandArrows(ctx: CanvasRenderingContext2D, x1: number, x2: number, rowY: number, rowH: number, strand: string, plotFrom: number, plotTo: number) {
    const left = Math.max(x1, plotFrom);
    const right = Math.min(x2, plotTo);
    if (right - left < 10) return;

    const arrowH = rowH * 0.8;
    const halfH = arrowH / 2;
    const midY = rowY + rowH / 2;
    const spacing = 18;
    const arrowW = 5;
    const dir = strand === "-" ? -1 : 1;

    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const start = Math.ceil((left + spacing / 2) / spacing) * spacing;
    for (let cx = start; cx < right - spacing / 2; cx += spacing) {
        ctx.beginPath();
        ctx.moveTo(cx - (dir * arrowW) / 2, midY - halfH);
        ctx.lineTo(cx + (dir * arrowW) / 2, midY);
        ctx.lineTo(cx - (dir * arrowW) / 2, midY + halfH);
        ctx.stroke();
    }
}

// The toggle hit region spans the full plot width (not just the label) so clicking anywhere
// on a transcript's exon-model bar expands/collapses it, not just the small text label.
function drawToggleLabel(
    ctx: CanvasRenderingContext2D,
    marginL: number,
    width: number,
    label: string,
    collapsed: boolean,
    y: number,
    rowH: number,
    id: string,
    hitRects: HitRect[],
    bold = false,
    canToggle = true,
) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, y - 1, marginL - 2, rowH + 2);
    ctx.fillStyle = bold ? "#1f2933" : "#6b7280";
    ctx.font = `${bold ? "700" : "400"} 11px -apple-system, sans-serif`;
    if (canToggle) ctx.fillText(collapsed ? "▸" : "▾", 4, y + rowH - 1);
    ctx.fillText(label, 4 + TOGGLE_GLYPH_W, y + rowH - 1);
    if (canToggle) hitRects.push({ x1: 0, x2: width - MARGIN_R, y1: y - 1, y2: y + rowH + 1, kind: "toggle", id });
}

function drawCigarDetail(ctx: CanvasRenderingContext2D, r: BamRecord, scaleX: ScaleX, rowY: number) {
    let refPos = r.start;
    for (const [op, len] of r.cigar) {
        if (op === "M" || op === "=" || op === "X" || op === "D") {
            if (op === "D" && len > 0) {
                const x1 = scaleX(refPos);
                const x2 = scaleX(refPos + len);
                ctx.strokeStyle = "#1f2933";
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(x1, rowY + ROW_H / 2);
                ctx.lineTo(x2, rowY + ROW_H / 2);
                ctx.stroke();
            }
            refPos += len;
        } else if (op === "N") {
            refPos += len;
        } else if (op === "I") {
            const x = scaleX(refPos);
            ctx.fillStyle = "#7c3aed";
            ctx.fillRect(x - 1, rowY - 2, 2, ROW_H + 4);
        }
    }
}

type HitRect =
    | { x1: number; x2: number; y1: number; y2: number; kind: "read"; read: BamRecord }
    | { x1: number; x2: number; y1: number; y2: number; kind: "gene"; gene: ExonGene }
    | { x1: number; x2: number; y1: number; y2: number; kind: "generegion" }
    | { x1: number; x2: number; y1: number; y2: number; kind: "toggle"; id: string };

interface AlignmentCanvasProps {
    gene: ExonGene;
    records: BamRecord[];
    exonIndexById: Map<string, ExonGene>;
    locked: boolean;
    sharedView: { start: number; end: number } | null;
    transcriptSortMode: TranscriptSortMode;
    onTranscriptSortModeChange: (mode: TranscriptSortMode) => void;
    transcriptOrder: string[] | null;
    minimumReadCount: number;
    onMinimumReadCountChange: (value: number) => void;
    visibleTranscriptIds: string[] | null;
    onViewChange: (view: { start: number; end: number }) => void;
}

export default function AlignmentCanvas({
    gene,
    records,
    exonIndexById,
    locked,
    sharedView,
    transcriptSortMode,
    onTranscriptSortModeChange,
    transcriptOrder,
    minimumReadCount,
    onMinimumReadCountChange,
    visibleTranscriptIds,
    onViewChange,
}: AlignmentCanvasProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const tooltipRef = useRef<HTMLDivElement>(null);
    const hitRectsRef = useRef<HitRect[]>([]);
    const draggingRef = useRef<{ startX: number; startY: number; view: { start: number; end: number } } | null>(null);

    const [width, setWidth] = useState(600);
    const [tooltip, setTooltip] = useState<{ hit: HitRect; x: number; y: number } | null>(null);
    const [selectedRead, setSelectedRead] = useState<BamRecord | null>(null);
    const [hoverToggle, setHoverToggle] = useState(false);
    const [mouseX, setMouseX] = useState<number | null>(null);

    const geneStart0 = gene.start - 1;
    const orderedTranscripts = useMemo(() => {
        const list = gene.transcripts || EMPTY_TRANSCRIPTS;
        if (transcriptSortMode === "name") return [...list].sort(compareTranscriptsByName);
        if (!transcriptOrder) return sortTranscriptsByReadCount(list, records);

        const orderById = new Map(transcriptOrder.map((id, index) => [id, index]));
        return [...list].sort((a, b) =>
            (orderById.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (orderById.get(b.id) ?? Number.MAX_SAFE_INTEGER)
            || compareTranscriptsByName(a, b),
        );
    }, [gene, records, transcriptSortMode, transcriptOrder]);

    const transcripts = useMemo(() => {
        const ids = visibleTranscriptIds
            ?? transcriptsMeetingMinimumReadCount(gene.transcripts || EMPTY_TRANSCRIPTS, [records], minimumReadCount);
        const visibleIds = new Set(ids);
        return orderedTranscripts.filter((transcript) => visibleIds.has(transcript.id));
    }, [gene, records, orderedTranscripts, minimumReadCount, visibleTranscriptIds]);

    const selectedGeneRecords = useMemo(
        () => records.filter((record) => isAnnotatedToGene(record, gene)),
        [gene, records],
    );

    // Every transcript (plus the unassigned-reads lane) starts with just its exon structure.
    // Repeated clicks cycle through reads+density, density only, and back to transcript only.
    // Reset when a different gene is opened.
    const [laneViewModes, setLaneViewModes] = useState<Map<string, LaneViewMode>>(() => new Map());

    useEffect(() => {
        setLaneViewModes(new Map());
        setSelectedRead(null);
        setTooltip(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [gene.id]);

    function cycleLaneView(id: string) {
        setLaneViewModes((prev) => {
            const next = new Map(prev);
            const current = next.get(id) ?? "transcript";
            next.set(id, current === "transcript" ? "reads" : current === "reads" ? "density" : "transcript");
            return next;
        });
    }

    // Whole-region peak depth per lane (not view-filtered), so it stays stable across pan/zoom.
    const ownPeaks = useMemo(() => {
        const map = new Map<string, number>();
        const assignedTranscriptIds = new Set((gene.transcripts || EMPTY_TRANSCRIPTS).map((t) => t.id));
        for (const t of transcripts) {
            map.set(t.id, computeMaxDepth(records.filter((r) => r.tags.nT === t.id)));
        }
        const unassigned = selectedGeneRecords.filter((r) => !r.tags.nT || !assignedTranscriptIds.has(r.tags.nT as string));
        map.set(UNASSIGNED_ID, computeMaxDepth(unassigned));
        return map;
    }, [gene, records, selectedGeneRecords, transcripts]);

    const mergedExons = useMemo(() => {
        const all = transcripts.flatMap((t) => t.exons).sort((a, b) => a[0] - b[0]);
        const merged: [number, number][] = [];
        for (const [s, e] of all) {
            const last = merged[merged.length - 1];
            if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
            else merged.push([s, e]);
        }
        return merged;
    }, [transcripts]);

    const hardStart0 = useMemo(() => {
        let s = geneStart0;
        for (const r of records) if (r.start < s) s = r.start;
        const pad = Math.max(200, Math.round(((() => {
            let e = gene.end;
            for (const r of records) if (r.end > e) e = r.end;
            return e;
        })() - s) * 0.05));
        return s - pad;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [gene.id, records]);

    const rightLabelWidth = useMemo(() => {
        const measureCanvas = document.createElement("canvas");
        const measureCtx = measureCanvas.getContext("2d")!;
        const assignedReadCounts = new Map<string, number>();
        for (const record of selectedGeneRecords) {
            if (typeof record.tags.nT !== "string") continue;
            assignedReadCounts.set(record.tags.nT, (assignedReadCounts.get(record.tags.nT) ?? 0) + 1);
        }

        let maxWidth = 0;
        for (const transcript of transcripts) {
            if (!transcript.name || transcript.name === transcript.id) continue;
            measureCtx.font = `${transcript.isMane ? "700" : "400"} 11px -apple-system, sans-serif`;
            const suffix = formatReadSuffix(assignedReadCounts.get(transcript.id) ?? 0, selectedGeneRecords.length);
            maxWidth = Math.max(maxWidth, measureCtx.measureText(`${transcript.name}${suffix}`).width);
        }
        return maxWidth;
    }, [selectedGeneRecords, transcripts]);

    const hardEnd0 = useMemo(() => {
        let e = gene.end;
        for (const r of records) if (r.end > e) e = r.end;
        let s = geneStart0;
        for (const r of records) if (r.start < s) s = r.start;
        const span = e - s;
        const leftPad = Math.max(200, Math.round(span * 0.05));
        const baselineRightPad = Math.max(200, Math.round(span * 0.05));
        const plotWidth = Math.max(1, width - MARGIN_L_MAX - MARGIN_R);
        const requiredLabelSpace = Math.min(plotWidth - 1, rightLabelWidth + 10);
        const labelRightPad = requiredLabelSpace > 0
            ? Math.ceil((requiredLabelSpace * (span + leftPad)) / (plotWidth - requiredLabelSpace))
            : 0;
        return e + Math.max(baselineRightPad, labelRightPad);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [gene.id, records, width, rightLabelWidth]);

    const [view, setView] = useState({ start: hardStart0, end: hardEnd0 });

    const effectiveView = locked && sharedView ? sharedView : view;

    function updateView(nextView: { start: number; end: number }) {
        setView(nextView);
        onViewChange(nextView);
    }

    const updateViewRef = useRef(updateView);
    updateViewRef.current = updateView;

    useEffect(() => {
        if (locked && sharedView) setView(sharedView);
    }, [locked, sharedView]);

    // Reset pan/zoom whenever a different gene's alignments are opened
    useEffect(() => {
        const nextView = { start: hardStart0, end: hardEnd0 };
        setView(nextView);
        if (!locked) onViewChange(nextView);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [hardStart0, hardEnd0, locked]);

    const overlappingGenes = useMemo(
        () =>
            [...exonIndexById.values()]
                .filter((g) => g.id !== gene.id && g.chrom === gene.chrom && g.start - 1 < hardEnd0 && g.end > hardStart0)
                .sort((a, b) => a.start - b.start),
        [exonIndexById, gene.id, gene.chrom, hardStart0, hardEnd0],
    );

    const marginL = useMemo(() => {
        const measureCanvas = document.createElement("canvas");
        const measureCtx = measureCanvas.getContext("2d")!;
        measureCtx.font = "11px -apple-system, sans-serif";
        const TRIANGLE_W = 14; // "▸ " / "▾ " prefix on collapsible lane labels
        let labelWidth = 0;
        for (const t of transcripts) labelWidth = Math.max(labelWidth, measureCtx.measureText(t.id).width + TRIANGLE_W);
        labelWidth = Math.max(labelWidth, measureCtx.measureText("Unassigned").width + TRIANGLE_W);
        for (const g of overlappingGenes) {
            labelWidth = Math.max(labelWidth, measureCtx.measureText(g.name && g.name !== g.id ? g.name : g.id).width);
        }
        return Math.min(MARGIN_L_MAX, Math.max(MARGIN_L_MIN, labelWidth + 12));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [transcripts, overlappingGenes]);

    useLayoutEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const updateWidth = () => {
            setWidth(Math.max(600, container.clientWidth - 20 || document.body.clientWidth - 60));
        };
        updateWidth();

        const observer = new ResizeObserver(updateWidth);
        observer.observe(container);
        return () => observer.disconnect();
    }, []);

    function clampView(newStart: number, newEnd: number): [number, number] {
        const w = newEnd - newStart;
        if (newStart < hardStart0) { newStart = hardStart0; newEnd = newStart + w; }
        if (newEnd > hardEnd0) { newEnd = hardEnd0; newStart = newEnd - w; }
        return [Math.max(hardStart0, newStart), Math.min(hardEnd0, newEnd)];
    }

    function setViewWidth(bp: number) {
        const newWidth = Math.max(MIN_VIEW_BP, Math.min(bp, hardEnd0 - hardStart0));
        const center = (effectiveView.start + effectiveView.end) / 2;
        const [s, e] = clampView(center - newWidth / 2, center + newWidth / 2);
        updateView({ start: s, end: e });
    }

    function panByFraction(frac: number) {
        const shift = (effectiveView.end - effectiveView.start) * frac;
        const [s, e] = clampView(effectiveView.start + shift, effectiveView.end + shift);
        updateView({ start: s, end: e });
    }

    // ---- draw ----
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const scaleX: ScaleX = (g) => marginL + ((g - effectiveView.start) / (effectiveView.end - effectiveView.start)) * (width - marginL - MARGIN_R);
        const pxPerBase = scaleX(1) - scaleX(0);
        const showCigarDetail = pxPerBase >= CIGAR_DETAIL_MIN_PX_PER_BASE;

        const visible = records.filter((r) => r.start < effectiveView.end && r.end > effectiveView.start);
        const assignedTranscriptIds = new Set((gene.transcripts || EMPTY_TRANSCRIPTS).map((t) => t.id));
        const totalReadCount = selectedGeneRecords.length;

        type TranscriptLane = {
            kind: "transcript";
            t: ExonTranscript;
            collapsed: boolean;
            showDensity: boolean;
            showReads: boolean;
            hasAssignedReads: boolean;
            readCount: number;
            layout: ReturnType<typeof layoutLane> | null;
            density: Float64Array | null;
        };
        type UnassignedLane = {
            kind: "unassigned";
            hasReads: boolean;
            collapsed: boolean;
            showDensity: boolean;
            showReads: boolean;
            geneLevelLayout: ReturnType<typeof layoutLane> | null;
            noMatchLayout: ReturnType<typeof layoutLane> | null;
            density: Float64Array | null;
            readCount: number;
        };
        type Lane = TranscriptLane | UnassignedLane;

        const pxFrom = marginL;
        const pxTo = width - MARGIN_R;

        // No point drawing an empty bordered box when not one of the open BAM panels has any
        // reads for this transcript - just show the exon model on its own.
        const hasDensity = (id: string) => (ownPeaks.get(id) ?? 0) > 0;

        // Collapsed lanes show only the transcript/merged exon structure. Expanded lanes add the
        // quantitative density track (when there's anything to show) and the individual reads.
        const lanes: Lane[] = transcripts.map((t) => {
            const reads = visible.filter((r) => r.tags.nT === t.id);
            const readCount = selectedGeneRecords.filter((r) => r.tags.nT === t.id).length;
            const mode = readCount > 0 ? laneViewModes.get(t.id) ?? "transcript" : "transcript";
            const showReads = mode === "reads";
            return {
                kind: "transcript", t, collapsed: mode === "transcript",
                showDensity: mode !== "transcript",
                showReads,
                hasAssignedReads: readCount > 0,
                readCount,
                layout: showReads ? layoutLane(reads) : null,
                density: computeCoverage(reads, scaleX, pxFrom, pxTo),
            };
        });

        const unassigned = visible.filter((r) => !r.tags.nT || !assignedTranscriptIds.has(r.tags.nT as string));
        const selectedGeneUnassigned = unassigned.filter((r) => isAnnotatedToGene(r, gene));
        const unassignedReadCount = selectedGeneRecords.filter((r) => !r.tags.nT || !assignedTranscriptIds.has(r.tags.nT as string)).length;
        const geneLevelReads = unassigned.filter((r) => r.tags.nR === "gene" && isAnnotatedToGene(r, gene));
        const noMatchReads = unassigned.filter((r) => r.tags.nR !== "gene" || !isAnnotatedToGene(r, gene));
        const hasVisibleUnassignedReads = records.some((r) => !r.tags.nT || !assignedTranscriptIds.has(r.tags.nT as string));
        const unassignedMode = hasVisibleUnassignedReads ? laneViewModes.get(UNASSIGNED_ID) ?? "transcript" : "transcript";
        const showUnassignedReads = unassignedMode === "reads";
        const unassignedDensity = computeCoverage(selectedGeneUnassigned, scaleX, pxFrom, pxTo);
        lanes.push({
            kind: "unassigned",
            hasReads: hasVisibleUnassignedReads,
            collapsed: unassignedMode === "transcript",
            showDensity: unassignedMode !== "transcript",
            showReads: showUnassignedReads,
            geneLevelLayout: showUnassignedReads ? layoutLane(geneLevelReads) : null,
            noMatchLayout: showUnassignedReads ? layoutLane(noMatchReads) : null,
            density: unassignedDensity,
            readCount: unassignedReadCount,
        });

        const geneItems = overlappingGenes
            .filter((g) => g.start - 1 < effectiveView.end && g.end > effectiveView.start)
            .map((g) => ({ start: g.start - 1, end: g.end, gene: g }));
        const geneLayout = packGeneItems(geneItems, scaleX);
        const contextHeight = geneLayout.rowCount > 0
            ? SEP_GAP + 1 + SEP_GAP + 14 + LANE_INNER_GAP + geneLayout.rowCount * (GENE_ROW_H + ROW_GAP) + LANE_BOTTOM_GAP
            : 0;

        let height = 30 + GENE_REGION_ROW_H + SEP_GAP + contextHeight;
        for (const lane of lanes) {
            height += SEP_GAP;
            const id = lane.kind === "transcript" ? lane.t.id : UNASSIGNED_ID;
            height += lane.showDensity && hasDensity(id) ? DENSITY_TRACK_H + DENSITY_GAP + EXON_ROW_H : EXON_ROW_H;
            if (lane.showReads && lane.kind === "transcript") {
                height += LANE_INNER_GAP + lane.layout!.rowCount * (ROW_H + ROW_GAP) + LANE_BOTTOM_GAP;
            } else if (lane.showReads && lane.kind === "unassigned") {
                height += LANE_INNER_GAP;
                height += 14 + LANE_INNER_GAP + lane.geneLevelLayout!.rowCount * (ROW_H + ROW_GAP) + LANE_BOTTOM_GAP;
                height += 14 + LANE_INNER_GAP + lane.noMatchLayout!.rowCount * (ROW_H + ROW_GAP) + LANE_BOTTOM_GAP;
            }
        }

        const dpr = window.devicePixelRatio || 1;
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        canvas.style.width = width + "px";
        canvas.style.height = height + "px";
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);

        if (selectedRead) {
            ctx.fillStyle = "rgba(239,68,68,0.12)";
            for (const [bStart, bEnd] of selectedRead.blocks) {
                const x1 = Math.max(pxFrom, scaleX(bStart));
                const x2 = Math.min(pxTo, scaleX(bEnd));
                if (x2 <= x1) continue;
                ctx.fillRect(x1, 30, Math.max(1, x2 - x1), Math.max(0, height - 30));
            }
        }

        const hitRects: HitRect[] = [];
        let y = 30;

        // Gene region indicator
        {
            const gx1 = scaleX(geneStart0);
            const gx2 = scaleX(gene.end);
            ctx.fillStyle = "#0e7490";
            ctx.fillRect(gx1, y, Math.max(1, gx2 - gx1), GENE_REGION_ROW_H);
            drawStrandArrows(ctx, gx1, gx2, y, GENE_REGION_ROW_H, gene.strand, pxFrom, pxTo);

            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, y - 1, marginL - 2, GENE_REGION_ROW_H + 2);
            ctx.fillStyle = "#0e7490";
            ctx.font = "600 11px -apple-system, sans-serif";
            ctx.fillText("Gene region", 4, y + GENE_REGION_ROW_H - 1);

            hitRects.push({ x1: gx1, x2: gx2, y1: y, y2: y + GENE_REGION_ROW_H, kind: "generegion" });

            y += GENE_REGION_ROW_H + SEP_GAP;
        }

        for (const lane of lanes) {
            y += SEP_GAP;

            if (lane.kind === "transcript") {
                const t = lane.t;
                const drawExonRow = (rowY: number) => {
                    const midY = rowY + EXON_ROW_H / 2;
                    ctx.strokeStyle = "#9aa5b1";
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.moveTo(scaleX(t.start - 1), midY);
                    ctx.lineTo(scaleX(t.end), midY);
                    ctx.stroke();

                    ctx.fillStyle = lane.hasAssignedReads ? "#3b4754" : "#d1d5db";
                    for (const [exStart, exEnd] of t.exons) {
                        const x1 = scaleX(exStart - 1);
                        const x2 = scaleX(exEnd);
                        ctx.fillRect(x1, rowY, Math.max(1, x2 - x1), EXON_ROW_H);
                    }

                    if (t.name && t.name !== t.id) {
                        ctx.fillStyle = t.isMane ? "#1f2933" : "#6b7280";
                        ctx.font = `${t.isMane ? "700" : "400"} 11px -apple-system, sans-serif`;
                        const readCountSuffix = formatReadSuffix(lane.readCount, totalReadCount);
                        ctx.fillText(`${t.name}${readCountSuffix}`, scaleX(t.end) + 6, rowY + EXON_ROW_H - 1);
                    }

                    drawToggleLabel(ctx, marginL, width, t.id, lane.collapsed, rowY, EXON_ROW_H, t.id, hitRects, t.isMane, lane.readCount > 0);
                };

                if (lane.showDensity && hasDensity(t.id)) {
                    drawDensityTrack(ctx, pxFrom, lane.density!, ownPeaks.get(t.id) ?? 0, y, DENSITY_TRACK_H);
                    hitRects.push({ x1: 0, x2: width - MARGIN_R, y1: y, y2: y + DENSITY_TRACK_H, kind: "toggle", id: t.id });
                    y += DENSITY_TRACK_H + DENSITY_GAP;
                }
                drawExonRow(y);
                y += EXON_ROW_H;
                if (lane.showReads) {
                    y += LANE_INNER_GAP;
                    for (const r of lane.layout!.reads) {
                        drawReadRow(ctx, r, y + r.row * (ROW_H + ROW_GAP), scaleX, showCigarDetail, r === selectedRead, gene, hitRects);
                    }
                    y += lane.layout!.rowCount * (ROW_H + ROW_GAP) + LANE_BOTTOM_GAP;
                }
            } else {
                const drawMergedExonRow = (rowY: number) => {
                    const midY = rowY + EXON_ROW_H / 2;
                    ctx.strokeStyle = "#9aa5b1";
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.moveTo(scaleX(geneStart0), midY);
                    ctx.lineTo(scaleX(gene.end), midY);
                    ctx.stroke();

                    ctx.fillStyle = "#5b6b85";
                    for (const [exStart, exEnd] of mergedExons) {
                        const x1 = scaleX(exStart - 1);
                        const x2 = scaleX(exEnd);
                        ctx.fillRect(x1, rowY, Math.max(1, x2 - x1), EXON_ROW_H);
                    }

                    ctx.fillStyle = "#6b7280";
                    ctx.font = "400 11px -apple-system, sans-serif";
                    ctx.fillText(
                        `Unassigned${formatReadSuffix(lane.readCount, totalReadCount)}`,
                        scaleX(gene.end) + 6,
                        rowY + EXON_ROW_H - 1,
                    );

                    // Reads without a gene annotation still need an expandable lane.
                    drawToggleLabel(ctx, marginL, width, "Unassigned", lane.collapsed, rowY, EXON_ROW_H, UNASSIGNED_ID, hitRects, false, lane.hasReads);
                };

                if (lane.showDensity && hasDensity(UNASSIGNED_ID)) {
                    drawDensityTrack(ctx, pxFrom, lane.density!, ownPeaks.get(UNASSIGNED_ID) ?? 0, y, DENSITY_TRACK_H);
                    hitRects.push({ x1: 0, x2: width - MARGIN_R, y1: y, y2: y + DENSITY_TRACK_H, kind: "toggle", id: UNASSIGNED_ID });
                    y += DENSITY_TRACK_H + DENSITY_GAP;
                }
                drawMergedExonRow(y);
                y += EXON_ROW_H;
                if (lane.showReads) {
                    y += LANE_INNER_GAP;

                    ctx.fillStyle = "#4b5563";
                    ctx.font = "600 11px -apple-system, sans-serif";
                    ctx.fillText("Gene-level match, no specific transcript (nR: gene)", 4, y + 11);
                    y += 14 + LANE_INNER_GAP;
                    for (const r of lane.geneLevelLayout!.reads) {
                        drawReadRow(ctx, r, y + r.row * (ROW_H + ROW_GAP), scaleX, showCigarDetail, r === selectedRead, gene, hitRects);
                    }
                    y += lane.geneLevelLayout!.rowCount * (ROW_H + ROW_GAP) + LANE_BOTTOM_GAP;

                    ctx.fillStyle = "#4b5563";
                    ctx.font = "600 11px -apple-system, sans-serif";
                    ctx.fillText("No match to this gene — may align to an overlapping gene", 4, y + 11);
                    y += 14 + LANE_INNER_GAP;
                    for (const r of lane.noMatchLayout!.reads) {
                        drawReadRow(ctx, r, y + r.row * (ROW_H + ROW_GAP), scaleX, showCigarDetail, r === selectedRead, gene, hitRects);
                    }
                    y += lane.noMatchLayout!.rowCount * (ROW_H + ROW_GAP) + LANE_BOTTOM_GAP;
                }
            }
        }

        if (geneLayout.rowCount > 0) {
            y += SEP_GAP;
            ctx.strokeStyle = "#b6bcc4";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(marginL, Math.round(y) + 0.5);
            ctx.lineTo(width - MARGIN_R, Math.round(y) + 0.5);
            ctx.stroke();
            y += SEP_GAP;

            ctx.fillStyle = "#4b5563";
            ctx.font = "600 11px -apple-system, sans-serif";
            ctx.fillText("Overlapping genes (context only, no transcript detail)", 4, y + 11);
            y += 14 + LANE_INNER_GAP;

            for (const item of geneLayout.items) {
                const g = item.gene;
                const rowY = y + item.row * (GENE_ROW_H + ROW_GAP);
                const x1 = scaleX(item.start);
                const x2 = scaleX(item.end);

                ctx.fillStyle = "#a3b8d8";
                ctx.fillRect(x1, rowY, Math.max(1, x2 - x1), GENE_ROW_H);
                drawStrandArrows(ctx, x1, x2, rowY, GENE_ROW_H, g.strand, pxFrom, pxTo);

                ctx.fillStyle = "#ffffff";
                ctx.fillRect(0, rowY - 1, marginL - 2, GENE_ROW_H + 2);
                ctx.fillStyle = "#5b6b85";
                ctx.font = "11px -apple-system, sans-serif";
                ctx.fillText(g.name && g.name !== g.id ? g.name : g.id, 4, rowY + GENE_ROW_H - 1);

                hitRects.push({ x1, x2, y1: rowY, y2: rowY + GENE_ROW_H, kind: "gene", gene: g });
            }
        }

        hitRectsRef.current = hitRects;
    }, [effectiveView, records, selectedGeneRecords, gene, transcripts, overlappingGenes, marginL, width, geneStart0, laneViewModes, mergedExons, ownPeaks, selectedRead]);

    // Paint after every render so a track redraw also restores the ruler, while mouse
    // movement alone only redraws this small strip rather than all the reads.
    useEffect(() => {
        const ctx = canvasRef.current?.getContext("2d");
        if (!ctx) return;
        const right = width - MARGIN_R;
        ctx.save();
        ctx.clearRect(0, 0, width, 25);
        ctx.strokeStyle = "#d7dbe0";
        ctx.fillStyle = "#6b7280";
        ctx.font = "11px -apple-system, sans-serif";
        ctx.beginPath();
        ctx.moveTo(marginL, 20.5);
        ctx.lineTo(right, 20.5);
        ctx.stroke();
        ctx.fillText(Math.round(effectiveView.start + 1).toLocaleString(), marginL, 14);
        const endLabel = Math.round(effectiveView.end).toLocaleString();
        ctx.fillText(endLabel, right - ctx.measureText(endLabel).width, 14);

        if (mouseX !== null && mouseX >= marginL && mouseX <= right) {
            const fraction = (mouseX - marginL) / (right - marginL);
            const viewSpan = effectiveView.end - effectiveView.start;
            const pxPerBase = (right - marginL) / viewSpan;
            // Bases occupy zero-based, half-open intervals; label them one-based.
            // At the right endpoint, keep highlighting the last visible base.
            const baseStart = Math.min(
                Math.floor(effectiveView.start + fraction * viewSpan),
                Math.ceil(effectiveView.end) - 1,
            );
            const position = baseStart + 1;
            const baseLeft = marginL + (baseStart - effectiveView.start) * pxPerBase;
            const left = Math.max(marginL, baseLeft);
            const rightEdge = Math.min(right, baseLeft + pxPerBase);
            const labelCenter = pxPerBase > 1 ? (left + rightEdge) / 2 : mouseX;
            const label = position.toLocaleString();
            const labelWidth = ctx.measureText(label).width;
            const labelX = Math.max(marginL, Math.min(right - labelWidth, labelCenter - labelWidth / 2));
            // Keep the moving label legible when it meets either endpoint label.
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(labelX - 3, 1, labelWidth + 6, 16);
            ctx.fillStyle = "#0e7490";
            ctx.fillText(label, labelX, 14);
            if (pxPerBase > 1) {
                ctx.fillStyle = "rgba(14, 116, 144, 0.3)";
                ctx.fillRect(left, 17, rightEdge - left, 7);
            } else {
                ctx.strokeStyle = "#0e7490";
                ctx.beginPath();
                ctx.moveTo(mouseX, 17);
                ctx.lineTo(mouseX, 24);
                ctx.stroke();
            }
        }
        ctx.restore();
    });

    // ---- tooltip positioning: flip to stay inside the viewport ----
    useLayoutEffect(() => {
        if (!tooltip || !tooltipRef.current) return;
        const pad = 14;
        const rect = tooltipRef.current.getBoundingClientRect();
        let left = tooltip.x + pad;
        let top = tooltip.y + pad;
        if (left + rect.width > window.innerWidth) left = tooltip.x - pad - rect.width;
        if (top + rect.height > window.innerHeight) top = tooltip.y - pad - rect.height;
        tooltipRef.current.style.left = Math.max(4, left) + "px";
        tooltipRef.current.style.top = Math.max(4, top) + "px";
    }, [tooltip]);

    function handleWheel(evt: WheelEvent) {
        // Trackpad two-finger scroll fires plain wheel events indistinguishable from a mouse
        // wheel except by gesture. A plain scroll passes through so the panel's own vertical
        // scrollbar handles it - otherwise scrolling through a tall track fights with navigation.
        if (!evt.ctrlKey && !evt.metaKey && !evt.shiftKey) return;
        evt.preventDefault();
        if (evt.shiftKey && !evt.ctrlKey && !evt.metaKey) {
            const curWidth = effectiveView.end - effectiveView.start;
            const bpPerPx = curWidth / (width - marginL - MARGIN_R);
            const deltaPx = evt.deltaX !== 0 ? evt.deltaX : evt.deltaY;
            const shift = -deltaPx * bpPerPx;
            const [s, e] = clampView(effectiveView.start + shift, effectiveView.end + shift);
            updateView({ start: s, end: e });
            return;
        }

        const rect = canvasRef.current?.getBoundingClientRect();
        if (!rect) return;
        const mx = evt.clientX - rect.left;
        const curWidth = effectiveView.end - effectiveView.start;
        const cursorGenomic = effectiveView.start + ((mx - marginL) / (width - marginL - MARGIN_R)) * curWidth;
        const factor = evt.deltaY > 0 ? ZOOM_OUT_FACTOR : ZOOM_IN_FACTOR;
        const newWidth = Math.max(MIN_VIEW_BP, Math.min(curWidth * factor, hardEnd0 - hardStart0));
        const ratio = (cursorGenomic - effectiveView.start) / curWidth;
        const newStart = cursorGenomic - ratio * newWidth;
        const [s, e] = clampView(newStart, newStart + newWidth);
        updateView({ start: s, end: e });
    }

    // Native capture listener is required so preventDefault can suppress browser zoom across
    // the full scrollable panel body, including the spacer below the canvas.
    const handleWheelRef = useRef(handleWheel);
    handleWheelRef.current = handleWheel;
    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        const panelBody = container.closest<HTMLElement>(".alignment-panel-body");
        if (!panelBody) return;

        function onWheel(evt: WheelEvent) {
            handleWheelRef.current(evt);
        }

        panelBody.addEventListener("wheel", onWheel, { passive: false, capture: true });
        return () => panelBody.removeEventListener("wheel", onWheel, { capture: true });
    }, []);

    // Below this many px of movement between mousedown and mouseup, treat the gesture as a
    // click (show/update the tooltip) rather than a pan.
    const CLICK_MOVE_THRESHOLD = 4;

    function handleMouseDown(evt: React.MouseEvent<HTMLCanvasElement>) {
        const rect = evt.currentTarget.getBoundingClientRect();
        const mx = evt.clientX - rect.left;
        const my = evt.clientY - rect.top;
        const toggleHit = hitRectsRef.current.find(
            (h): h is Extract<HitRect, { kind: "toggle" }> => h.kind === "toggle" && mx >= h.x1 && mx <= h.x2 && my >= h.y1 && my <= h.y2,
        );
        if (toggleHit) {
            setTooltip(null);
            setSelectedRead(null);
            cycleLaneView(toggleHit.id);
            return;
        }
        draggingRef.current = { startX: evt.clientX, startY: evt.clientY, view: { ...effectiveView } };
    }

    useEffect(() => {
        function onMove(evt: MouseEvent) {
            const dragging = draggingRef.current;
            if (!dragging) return;
            const dx = evt.clientX - dragging.startX;
            const curWidth = dragging.view.end - dragging.view.start;
            const bpPerPx = curWidth / (width - marginL - MARGIN_R);
            const shift = -dx * bpPerPx;
            const [s, e] = clampView(dragging.view.start + shift, dragging.view.end + shift);
            updateViewRef.current({ start: s, end: e });
        }
        function onUp(evt: MouseEvent) {
            const dragging = draggingRef.current;
            draggingRef.current = null;
            if (!dragging) return;
            const dx = evt.clientX - dragging.startX;
            const dy = evt.clientY - dragging.startY;
            if (Math.hypot(dx, dy) >= CLICK_MOVE_THRESHOLD) return; // was a pan, not a click

            const canvas = canvasRef.current;
            if (!canvas) return;
            const rect = canvas.getBoundingClientRect();
            const mx = evt.clientX - rect.left;
            const my = evt.clientY - rect.top;
            const hit = hitRectsRef.current.find((h) => mx >= h.x1 && mx <= h.x2 && my >= h.y1 && my <= h.y2);
            setSelectedRead(hit?.kind === "read" ? hit.read : null);
            setTooltip(hit && hit.kind !== "toggle" ? { hit, x: evt.clientX, y: evt.clientY } : null);
        }
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
        return () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [width, marginL, hardStart0, hardEnd0]);

    function handleDoubleClick() {
        updateView({ start: hardStart0, end: hardEnd0 });
    }

    // Tooltip content is click-driven; movement updates the ruler and hover cursor.
    function handleMouseMove(evt: React.MouseEvent<HTMLCanvasElement | HTMLDivElement>) {
        const rect = canvasRef.current?.getBoundingClientRect();
        if (!rect) return;
        const mx = evt.clientX - rect.left;
        setMouseX(mx);
        if (draggingRef.current) return;
        const my = evt.clientY - rect.top;
        const hit = hitRectsRef.current.find((h) => mx >= h.x1 && mx <= h.x2 && my >= h.y1 && my <= h.y2);
        setHoverToggle(hit?.kind === "toggle");
    }

    // Left/Right pan by a small fixed fraction of the current view. Up/Down use the same zoom
    // factors as Ctrl/Cmd+scroll, centered on the current view.
    function handleCanvasKeyDown(evt: React.KeyboardEvent<HTMLCanvasElement>) {
        if (evt.key !== "ArrowRight" && evt.key !== "ArrowLeft" && evt.key !== "ArrowUp" && evt.key !== "ArrowDown") return;
        evt.preventDefault();

        if (evt.key === "ArrowUp" || evt.key === "ArrowDown") {
            const curWidth = effectiveView.end - effectiveView.start;
            setViewWidth(curWidth * (evt.key === "ArrowUp" ? ZOOM_IN_FACTOR : ZOOM_OUT_FACTOR));
        } else {
            panByFraction(evt.key === "ArrowRight" ? -KEYBOARD_PAN_FRACTION : KEYBOARD_PAN_FRACTION);
        }
    }

    return (
        <div id="plot-container" ref={containerRef}>
            <div className="plot-toolbar">
                <select
                    className="transcript-sort-select"
                    value={transcriptSortMode}
                    aria-label="Transcript order"
                    title="Vertical transcript order"
                    onChange={(e) => onTranscriptSortModeChange(e.target.value as TranscriptSortMode)}
                >
                    <option value="name">Sort by name</option>
                    <option value="readCount">Sort by assigned reads</option>
                </select>
                <label className="minimum-read-filter">
                    Min reads
                    <input
                        type="number"
                        min="0"
                        step="1"
                        value={minimumReadCount}
                        onChange={(e) => {
                            const value = e.currentTarget.valueAsNumber;
                            onMinimumReadCountChange(Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0);
                        }}
                        aria-label="Minimum assigned reads per transcript"
                    />
                </label>
                <span className="plot-hint">ctrl/⌘+scroll or ↑/↓ to zoom · shift+scroll, drag, or ←/→ to pan · double-click to reset</span>
            </div>

            <canvas
                ref={canvasRef}
                tabIndex={0}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseLeave={() => {
                    setHoverToggle(false);
                    setMouseX(null);
                }}
                onDoubleClick={handleDoubleClick}
                style={{ cursor: draggingRef.current ? "grabbing" : hoverToggle ? "pointer" : "default" }}
                onKeyDown={handleCanvasKeyDown}
            />

            <div
                className="plot-footer-spacer"
                onMouseMove={handleMouseMove}
                onMouseLeave={() => setMouseX(null)}
            />

            {tooltip && (
                <div id="tooltip" ref={tooltipRef} style={{ display: "block" }}>
                    <button
                        type="button"
                        className="tooltip-close"
                        aria-label="Close tooltip"
                        onClick={() => setTooltip(null)}
                    >
                        ×
                    </button>
                    {tooltip.hit.kind === "generegion" && (
                        <>
                            <div><b>{gene.name && gene.name !== gene.id ? gene.name : gene.id}</b> - gene region</div>
                            <div>{gene.chrom}:{gene.start.toLocaleString()}-{gene.end.toLocaleString()}</div>
                        </>
                    )}
                    {tooltip.hit.kind === "gene" && (() => {
                        const g = tooltip.hit.gene;
                        return (
                            <>
                                <div><b>{g.name && g.name !== g.id ? g.name : g.id}</b></div>
                                <div>{g.chrom}:{g.start.toLocaleString()}-{g.end.toLocaleString()} ({g.strand} strand)</div>
                                <div>{g.id}</div>
                                <div className="stats-loading">Overlapping gene shown for context only</div>
                            </>
                        );
                    })()}
                    {tooltip.hit.kind === "read" && (() => {
                        const r = tooltip.hit.read;
                        return (
                            <>
                                <div><b>{r.readName}</b></div>
                                <div>{r.chrom}:{(r.start + 1).toLocaleString()}-{r.end.toLocaleString()} ({r.isReverse ? "-" : "+"} strand)</div>
                                <div>mapq {r.mapq} — {r.isSecondary ? "secondary" : "primary"} alignment</div>
                                <div>nG: {r.tags.nG ?? "—"}</div>
                                <div>nR: {r.tags.nR ?? "—"} &nbsp; nT: {r.tags.nT ?? "—"}</div>
                                <div>CIGAR:</div>
                                <div className="cigar-wrap">{renderCigarSpans(r.cigar)}</div>
                            </>
                        );
                    })()}
                </div>
            )}
        </div>
    );
}
