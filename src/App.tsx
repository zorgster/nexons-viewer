// Copyright (C) 2026 Oliver Slay and Simon Andrews
// SPDX-License-Identifier: GPL-3.0-only

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BaiRefIndex, BamRecord, ExonGene } from "./types";
import { parseBAMHeader, readBAI, fetchRegionRecords } from "./bamIo";
import { parseGtfFile } from "./gtfIo";
import Header, { type LayoutMode } from "./components/Header";
import Legend from "./components/Legend";
import GeneTabs, { type GeneTab } from "./components/GeneTabs";
import AlignmentPanel from "./components/AlignmentPanel";
import {
    rankTranscriptsAcrossPanels,
    transcriptsMeetingMinimumReadCount,
    type TranscriptSortMode,
} from "./transcriptSort";
import "./App.css";

interface BamSource {
    id: string;
    label: string;
    file: File;
    refNames: string[];
    chromToRefID: Map<string, number>;
    refIndex: BaiRefIndex[];
    ready: boolean;
    records: BamRecord[] | null;
    queryLoading: boolean;
    queryError: string | null;
    // Which gene the current records/queryLoading/queryError reflect - lets the query effect
    // tell "never queried" apart from "queried, but for a different gene" without a separate pass.
    queriedGeneId: string | null;
}

// Panels are up to 4 fixed slots, of which only the first `layoutMode` are shown (1 / 2x1 / 2x2).
// A slot holds a reference to a pool source (or none, rendered as an empty slot) - loading more
// BAM/BAI pairs than there are visible slots just adds them to the pool, still pickable from any
// slot's dropdown, including a slot that already shows another pair (sharing the same query
// result, no duplicate fetch). Slots beyond the current layout keep whatever they were assigned
// so switching layout back and forth doesn't lose anything.
const SLOT_COUNT = 4;

interface PanelSlot {
    sourceId: string | null;
    locked: boolean;
}

function makeEmptySlots(): PanelSlot[] {
    return Array.from({ length: SLOT_COUNT }, () => ({ sourceId: null, locked: true }));
}

function autoLayoutMode(readyCount: number): LayoutMode {
    if (readyCount <= 1) return 1;
    if (readyCount === 2) return 2;
    return 4;
}

function makeId() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export default function App() {
    const [exonIndexById, setExonIndexById] = useState<Map<string, ExonGene>>(new Map());
    const [exonFileName, setExonFileName] = useState("");
    const [gtfProgress, setGtfProgress] = useState<number | null>(null);
    const [tslLevel, setTslLevel] = useState("2");
    const lastGtfFileRef = useRef<File | null>(null);
    const [sources, setSources] = useState<BamSource[]>([]);
    const [slots, setSlots] = useState<PanelSlot[]>(makeEmptySlots());
    const [layoutMode, setLayoutMode] = useState<LayoutMode>(1);
    const layoutManualRef = useRef(false);
    const [status, setStatus] = useState("No GTF loaded");

    // Browser-tab-style gene navigation: each tab just carries a gene id, the panel layout and
    // BAM-to-slot assignments below are shared across every tab. Switching tabs re-queries the
    // same panels for the new gene's region rather than duplicating/caching per tab.
    const [tabs, setTabs] = useState<GeneTab[]>([]);
    const [activeTabId, setActiveTabId] = useState<string | null>(null);
    const [addressBarOpen, setAddressBarOpen] = useState(false);
    const [sharedView, setSharedView] = useState<{ start: number; end: number } | null>(null);
    const [transcriptSortMode, setTranscriptSortMode] = useState<TranscriptSortMode>("name");
    const [lockedMinimumReadCount, setLockedMinimumReadCount] = useState(0);
    const [slotMinimumReadCounts, setSlotMinimumReadCounts] = useState(() => Array<number>(SLOT_COUNT).fill(0));

    const queryTokensRef = useRef<Map<string, number>>(new Map());

    const bamFileLabel = sources.length === 0 ? "choose files…" : `${sources.length} set${sources.length === 1 ? "" : "s"}`;
    const anyBamReady = sources.some((s) => s.ready);

    const parseGtfWithLevel = useCallback(async (file: File, level: string) => {
        setGtfProgress(0);
        setExonIndexById(new Map()); // drop the previous index up front so it can be freed while the next one builds
        const map = new Map<string, ExonGene>();
        try {
            const maxTsl = level === "all" ? null : parseInt(level, 10);
            await parseGtfFile(file, maxTsl, {
                onProgress: (fraction) => setGtfProgress(fraction),
                onGenes: (chunk) => { for (const g of chunk) map.set(g.id, g); },
            });
            setExonIndexById(map);
            setExonFileName(file.name);
            setGtfProgress(null);
            if (!anyBamReady) setStatus("Load BAM+BAI files to query reads");
        } catch (err) {
            console.error("Could not parse GTF", err);
            setGtfProgress(null);
            setStatus("Failed to parse GTF: " + (err as Error).message);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [anyBamReady]);

    const handleExonIndexFile = useCallback(async (file: File) => {
        if (/\.json$/i.test(file.name)) {
            lastGtfFileRef.current = null;
            try {
                const text = await file.text();
                const genes: ExonGene[] = JSON.parse(text);
                const map = new Map<string, ExonGene>();
                for (const g of genes) map.set(g.id, g);
                setExonIndexById(map);
                setExonFileName(file.name);
                if (!anyBamReady) setStatus("Load BAM+BAI files to query reads");
            } catch (err) {
                console.error("Could not parse exon index JSON", err);
                setStatus("Failed to parse exon index JSON");
            }
            return;
        }
        lastGtfFileRef.current = file;
        await parseGtfWithLevel(file, tslLevel);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [anyBamReady, tslLevel, parseGtfWithLevel]);

    const handleTslLevelChange = useCallback((level: string) => {
        setTslLevel(level);
        if (lastGtfFileRef.current) parseGtfWithLevel(lastGtfFileRef.current, level);
    }, [parseGtfWithLevel]);

    const runQuery = useCallback(async (geneId: string, sourceId: string, geneMap: Map<string, ExonGene>) => {
        setSources((prev) => prev.map((s) => (s.id === sourceId ? { ...s, queryLoading: true, queryError: null, records: null, queriedGeneId: geneId } : s)));

        const token = (queryTokensRef.current.get(sourceId) ?? 0) + 1;
        queryTokensRef.current.set(sourceId, token);

        setSources((prev) => {
            const source = prev.find((s) => s.id === sourceId);
            const gene = geneMap.get(geneId);
            if (!source || !source.ready || !gene) return prev;

            const refID = source.chromToRefID.get(gene.chrom);
            if (refID === undefined) {
                return prev.map((s) => (s.id === sourceId ? { ...s, queryLoading: false, queryError: `"${gene.chrom}" isn't a reference in this BAM` } : s));
            }

            fetchRegionRecords(source.file, source.refIndex[refID], refID, gene.start - 1, gene.end, source.refNames)
                .then((recs) => {
                    if (queryTokensRef.current.get(sourceId) !== token) return;
                    setSources((cur) => cur.map((s) => (s.id === sourceId ? { ...s, queryLoading: false, records: recs } : s)));
                })
                .catch((err) => {
                    if (queryTokensRef.current.get(sourceId) !== token) return;
                    console.error(err);
                    setSources((cur) => cur.map((s) => (s.id === sourceId ? { ...s, queryLoading: false, queryError: "Region query failed: " + (err as Error).message } : s)));
                });

            return prev;
        });
    }, []);

    const handleBamBaiFiles = useCallback(async (pairs: { bamFile: File; baiFile: File }[]) => {
        setStatus(`Reading ${pairs.length} BAM header${pairs.length > 1 ? "s" : ""} and BAI index${pairs.length > 1 ? "es" : ""}…`);

        const newSources = await Promise.all(
            pairs.map(async ({ bamFile, baiFile }): Promise<BamSource> => {
                const id = makeId();
                try {
                    const [{ refNames }, refIndex] = await Promise.all([parseBAMHeader(bamFile), readBAI(baiFile)]);
                    const chromToRefID = new Map(refNames.map((name, i) => [name, i]));
                    return {
                        id, label: bamFile.name, file: bamFile, refNames, chromToRefID, refIndex,
                        ready: true, records: null, queryLoading: false, queryError: null, queriedGeneId: null,
                    };
                } catch (err) {
                    console.error(err);
                    return {
                        id, label: bamFile.name, file: bamFile, refNames: [], chromToRefID: new Map(), refIndex: [],
                        ready: false, records: null, queryLoading: false,
                        queryError: "Failed to load BAM/BAI: " + (err as Error).message, queriedGeneId: null,
                    };
                }
            }),
        );

        let totalReady = 0;
        setSources((prev) => {
            const next = [...prev, ...newSources];
            totalReady = next.filter((s) => s.ready).length;
            return next;
        });

        // Fill any empty panel slots with the newly loaded BAMs, in order; anything past the
        // 4 slots just sits in the pool, still selectable from any slot's dropdown.
        const readyIds = newSources.filter((s) => s.ready).map((s) => s.id);
        setSlots((prev) => {
            const next = [...prev];
            let idx = 0;
            for (let i = 0; i < next.length && idx < readyIds.length; i++) {
                if (next[i].sourceId === null) {
                    next[i] = { ...next[i], sourceId: readyIds[idx] };
                    idx++;
                }
            }
            return next;
        });

        // Suggest a layout that fits what's loaded so far, unless the user has already picked one.
        if (!layoutManualRef.current) setLayoutMode(autoLayoutMode(totalReady));

        const readyCount = readyIds.length;
        setStatus(readyCount > 0
            ? `${readyCount} BAM${readyCount > 1 ? "s" : ""} ready - select a gene to query its region`
            : "Failed to load one or more BAM/BAI files");
    }, []);

    const handleLayoutModeChange = useCallback((mode: LayoutMode) => {
        layoutManualRef.current = true;
        setLayoutMode(mode);
    }, []);

    const handleOpenAddressBar = useCallback(() => setAddressBarOpen(true), []);
    const handleCloseAddressBar = useCallback(() => setAddressBarOpen(false), []);

    const handlePickGene = useCallback((geneId: string) => {
        const tab: GeneTab = { id: makeId(), geneId };
        setTabs((prev) => [...prev, tab]);
        setActiveTabId(tab.id);
        setAddressBarOpen(false);
        setSharedView(null);
    }, []);

    const handleSelectTab = useCallback((tabId: string) => {
        setActiveTabId(tabId);
        setAddressBarOpen(false);
        setSharedView(null);
    }, []);

    const handleCloseTab = useCallback((tabId: string) => {
        setTabs((prev) => {
            const idx = prev.findIndex((t) => t.id === tabId);
            if (idx === -1) return prev;
            const next = prev.filter((t) => t.id !== tabId);
            setActiveTabId((cur) => {
                if (cur !== tabId) return cur;
                const fallbackIndex = idx > 0 ? idx - 1 : 0;
                return next[fallbackIndex]?.id ?? null;
            });
            return next;
        });
    }, []);

    const handleSlotSourceChange = useCallback((slotIndex: number, sourceId: string | null) => {
        setSlots((prev) => prev.map((slot, i) => (i === slotIndex ? { ...slot, sourceId } : slot)));
    }, []);

    const toggleSlotLock = useCallback((slotIndex: number) => {
        if (slots[slotIndex]?.locked) {
            setSlotMinimumReadCounts((prev) => prev.map((value, i) => i === slotIndex ? lockedMinimumReadCount : value));
        }
        setSlots((prev) => prev.map((slot, i) => (i === slotIndex ? { ...slot, locked: !slot.locked } : slot)));
    }, [slots, lockedMinimumReadCount]);

    const handleMinimumReadCountChange = useCallback((slotIndex: number, value: number) => {
        if (slots[slotIndex]?.locked) {
            setLockedMinimumReadCount(value);
        } else {
            setSlotMinimumReadCounts((prev) => prev.map((current, i) => i === slotIndex ? value : current));
        }
    }, [slots]);

    const handlePanelViewChange = useCallback((slotIndex: number, next: { start: number; end: number }) => {
        setSlots((prev) => {
            if (prev[slotIndex]?.locked) setSharedView(next);
            return prev;
        });
    }, []);

    const currentGeneId = tabs.find((t) => t.id === activeTabId)?.geneId ?? null;

    // Single source of truth for querying: runs whenever the selected gene, the visible slot
    // assignments, or the source pool change, and queries any slot-assigned, ready source
    // whose records don't already reflect the current gene. Switching tabs just changes
    // currentGeneId, which this picks up the same way a fresh gene selection would.
    useEffect(() => {
        if (!currentGeneId) return;
        const visibleSlots = slots.slice(0, layoutMode);
        const assignedIds = new Set(visibleSlots.map((s) => s.sourceId).filter((id): id is string => id !== null));
        for (const source of sources) {
            if (!assignedIds.has(source.id) || !source.ready || source.queryLoading) continue;
            if (source.queriedGeneId === currentGeneId) continue;
            runQuery(currentGeneId, source.id, exonIndexById);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentGeneId, slots, layoutMode, sources, exonIndexById]);

    const currentGene = currentGeneId ? exonIndexById.get(currentGeneId) ?? null : null;

    const lockedTranscriptOrder = useMemo(() => {
        if (!currentGene || !currentGeneId || transcriptSortMode !== "readCount") return null;

        const lockedSlots = slots
            .slice(0, layoutMode)
            .filter((slot): slot is PanelSlot & { sourceId: string } => slot.locked && slot.sourceId !== null);

        if (lockedSlots.length <= 1) return null;

        const panelRecords = lockedSlots.map((slot) => {
            const source = sources.find((candidate) => candidate.id === slot.sourceId);
            return source?.ready && source.queriedGeneId === currentGeneId && source.records
                ? source.records
                : [];
        });

        return rankTranscriptsAcrossPanels(currentGene.transcripts, panelRecords);
    }, [currentGene, currentGeneId, transcriptSortMode, slots, layoutMode, sources]);

    const lockedVisibleTranscriptIds = useMemo(() => {
        if (!currentGene || !currentGeneId) return null;

        const lockedSlots = slots
            .slice(0, layoutMode)
            .filter((slot): slot is PanelSlot & { sourceId: string } => slot.locked && slot.sourceId !== null);

        if (lockedSlots.length === 0) return null;

        const panelRecords = lockedSlots.map((slot) => {
            const source = sources.find((candidate) => candidate.id === slot.sourceId);
            return source?.ready && source.queriedGeneId === currentGeneId && source.records
                ? source.records
                : [];
        });

        return transcriptsMeetingMinimumReadCount(currentGene.transcripts, panelRecords, lockedMinimumReadCount);
    }, [currentGene, currentGeneId, lockedMinimumReadCount, slots, layoutMode, sources]);

    useEffect(() => {
        if (!currentGene || !currentGeneId) return;

        const lockedSources = slots
            .slice(0, layoutMode)
            .filter((slot) => slot.locked && slot.sourceId !== null)
            .map((slot) => sources.find((source) => source.id === slot.sourceId))
            .filter((source): source is BamSource => !!source && source.ready);

        if (lockedSources.length <= 1) return;
        const settled = lockedSources.every((source) =>
            source.queriedGeneId === currentGeneId
            && !source.queryLoading
            && (source.records !== null || source.queryError !== null)
        );
        if (!settled) return;

        let start = currentGene.start - 1;
        let end = currentGene.end;
        for (const source of lockedSources) {
            for (const record of source.records ?? []) {
                if (record.start < start) start = record.start;
                if (record.end > end) end = record.end;
            }
        }

        const pad = Math.max(200, Math.round((end - start) * 0.05));
        setSharedView({ start: start - pad, end: end + pad });
    }, [currentGene, currentGeneId, slots, layoutMode, sources]);

    const visibleSlotCount = layoutMode;
    const assignedCount = slots.slice(0, visibleSlotCount).filter((s) => s.sourceId !== null).length;
    const sourceOptions = useMemo(() => sources.map((s) => ({ id: s.id, label: s.label })), [sources]);
    const onboardingStep = exonIndexById.size === 0
        ? "gtf"
        : !anyBamReady
            ? "bam"
            : tabs.length === 0
                ? "gene"
                : null;

    function renderSlot(slotIndex: number) {
        const slot = slots[slotIndex];
        const source = slot.sourceId ? sources.find((s) => s.id === slot.sourceId) ?? null : null;
        return (
            <AlignmentPanel
                key={slotIndex}
                gene={currentGene}
                sourceOptions={sourceOptions}
                selectedSourceId={slot.sourceId}
                onSelectSource={(id) => handleSlotSourceChange(slotIndex, id)}
                records={source?.records ?? null}
                loading={source?.queryLoading ?? false}
                error={source?.queryError ?? null}
                exonIndexById={exonIndexById}
                locked={slot.locked}
                sharedView={sharedView}
                transcriptSortMode={transcriptSortMode}
                onTranscriptSortModeChange={setTranscriptSortMode}
                transcriptOrder={slot.locked ? lockedTranscriptOrder : null}
                minimumReadCount={slot.locked ? lockedMinimumReadCount : slotMinimumReadCounts[slotIndex]}
                onMinimumReadCountChange={(value) => handleMinimumReadCountChange(slotIndex, value)}
                visibleTranscriptIds={slot.locked ? lockedVisibleTranscriptIds : null}
                onViewChange={(v) => handlePanelViewChange(slotIndex, v)}
                onToggleLock={() => toggleSlotLock(slotIndex)}
                showLock={assignedCount > 1}
            />
        );
    }

    return (
        <>
            <Header
                exonFileName={exonFileName}
                gtfProgress={gtfProgress}
                bamFileLabel={bamFileLabel}
                onboardingStep={onboardingStep === "gtf" || onboardingStep === "bam" ? onboardingStep : null}
                status={status}
                tslLevel={tslLevel}
                onTslLevelChange={handleTslLevelChange}
                onExonIndexFile={handleExonIndexFile}
                onBamBaiFiles={handleBamBaiFiles}
                layoutMode={layoutMode}
                onLayoutModeChange={handleLayoutModeChange}
            />
            <Legend />

            <GeneTabs
                tabs={tabs}
                activeTabId={activeTabId}
                addressBarOpen={addressBarOpen}
                exonIndexById={exonIndexById}
                exonIndexReady={exonIndexById.size > 0}
                showAddGeneHint={onboardingStep === "gene"}
                onSelectTab={handleSelectTab}
                onCloseTab={handleCloseTab}
                onOpenAddressBar={handleOpenAddressBar}
                onCloseAddressBar={handleCloseAddressBar}
                onPickGene={handlePickGene}
            />

            {currentGene && sources.length > 0 ? (
                <div id="panelArea">
                    <div className={`panel-grid layout-${visibleSlotCount}`}>
                        {Array.from({ length: visibleSlotCount }, (_, i) => renderSlot(i))}
                    </div>
                </div>
            ) : (
                <div id="placeholder">
                    <div className="welcome-content">
                        <img className="welcome-logo" src={`${import.meta.env.BASE_URL}nexons_viewer_logo_path.svg`} alt="Nexons Viewer" />
                        <p className="welcome-intro">
                            Nexons Viewer lets you review the quantitation of nanopore sequencing data performed by the{" "}
                            <a href="https://github.com/s-andrews/nexons/" target="_blank" rel="noreferrer">Nexons analysis program</a>.
                            Nexons matches your aligned nanopore reads against transcript structures and quantitates them.
                            It also produces annotated BAM files which you can load into this viewer to see your alignments
                            and review the calls Nexons has made.
                        </p>
                        <p className="welcome-privacy">
                            Although nexons-viewer is a web application it reads your data locally. No data is sent to the server.
                        </p>
                        <h1>Getting Started</h1>
                        <ol className="welcome-steps">
                            <li>Load the same GTF file used to run Nexons.</li>
                            <li>Load one or more Nexons-annotated BAM files together with their matching BAI indices.</li>
                            <li>Select an initial gene to view.</li>
                        </ol>
                    </div>
                </div>
            )}
            <footer className="app-footer">
                Nexons viewer © Oliver Slay and Simon Andrews. {" "}
                <a href="https://github.com/s-andrews/nexons-viewer/issues/" target="_blank" rel="noreferrer">
                    Report a problem
                </a>
            </footer>
        </>
    );
}
