import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type ReactNode } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import type { BaiRefIndex, BamRecord, ExonGene } from "./types";
import { parseBAMHeader, readBAI, fetchRegionRecords } from "./bamIo";
import Header from "./components/Header";
import Legend from "./components/Legend";
import AlignmentPanel from "./components/AlignmentPanel";
import BamTabStrip, { type ViewMode } from "./components/BamTabStrip";
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
    locked: boolean;
}

function makeId() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// Row-count layout: 1-3 sources are a single row; 4+ split into two rows as evenly as possible
// (matching the requested 2 -> 2-up, 3 -> 3-up, 4 -> 2x2 arrangement).
function computeRows(n: number): number[] {
    if (n <= 3) return [n];
    const first = Math.ceil(n / 2);
    return [first, n - first];
}

export default function App() {
    const [exonIndexById, setExonIndexById] = useState<Map<string, ExonGene>>(new Map());
    const [exonFileName, setExonFileName] = useState("choose file…");
    const [sources, setSources] = useState<BamSource[]>([]);
    const [status, setStatus] = useState("No exon index loaded");

    const [currentGeneId, setCurrentGeneId] = useState<string | null>(null);
    const [viewingGeneId, setViewingGeneId] = useState<string | null>(null);
    const [sharedView, setSharedView] = useState<{ start: number; end: number } | null>(null);

    const [dragId, setDragId] = useState<string | null>(null);
    const [dropTargetId, setDropTargetId] = useState<string | null>(null);

    // Tab strip: which BAM source is shown in "single" mode, and single vs grid layout.
    const [viewMode, setViewMode] = useState<ViewMode>("grid");
    const [activeSourceId, setActiveSourceId] = useState<string | null>(null);
    const addFileInputRef = useRef<HTMLInputElement | null>(null);

    // Density-track peaks reported by each panel (per transcript id), merged across panels so
    // the same transcript scales identically no matter which BAM file it's being viewed in.
    const [peaksBySource, setPeaksBySource] = useState<Map<string, Map<string, number>>>(new Map());
    const peaksCallbacksRef = useRef<Map<string, (peaks: Map<string, number>) => void>>(new Map());

    const queryTokensRef = useRef<Map<string, number>>(new Map());

    const bamFileLabel = sources.length === 0 ? "choose files…" : sources.map((s) => s.label).join(", ");
    const anyBamReady = sources.some((s) => s.ready);

    const handleExonIndexFile = useCallback(async (file: File) => {
        setExonFileName(file.name);
        try {
            const text = await file.text();
            const genes: ExonGene[] = JSON.parse(text);
            const map = new Map<string, ExonGene>();
            for (const g of genes) map.set(g.id, g);
            setExonIndexById(map);
            setStatus(`${genes.length.toLocaleString()} genes loaded${anyBamReady ? "" : " - load BAM+BAI files to query reads"}`);
        } catch (err) {
            console.error("Could not parse exon index JSON", err);
            setStatus("Failed to parse exon index JSON");
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [anyBamReady]);

    const runQuery = useCallback(async (geneId: string, sourceId: string, geneMap: Map<string, ExonGene>) => {
        setSources((prev) => prev.map((s) => (s.id === sourceId ? { ...s, queryLoading: true, queryError: null, records: null } : s)));

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
                        ready: true, records: null, queryLoading: false, queryError: null, locked: true,
                    };
                } catch (err) {
                    console.error(err);
                    return {
                        id, label: bamFile.name, file: bamFile, refNames: [], chromToRefID: new Map(), refIndex: [],
                        ready: false, records: null, queryLoading: false,
                        queryError: "Failed to load BAM/BAI: " + (err as Error).message, locked: true,
                    };
                }
            }),
        );

        setSources((prev) => [...prev, ...newSources]);

        const readyCount = newSources.filter((s) => s.ready).length;
        setStatus(readyCount > 0
            ? `${readyCount} BAM${readyCount > 1 ? "s" : ""} ready - select a gene to query its region`
            : "Failed to load one or more BAM/BAI files");

        if (currentGeneId) {
            for (const s of newSources) if (s.ready) runQuery(currentGeneId, s.id, exonIndexById);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentGeneId, exonIndexById, runQuery]);

    const handleSelectGene = useCallback((geneId: string) => {
        setCurrentGeneId(geneId);
        setViewingGeneId(geneId);
        setSharedView(null);
        for (const s of sources) if (s.ready) runQuery(geneId, s.id, exonIndexById);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sources, exonIndexById, runQuery]);

    const removeSource = useCallback((sourceId: string) => {
        setSources((prev) => prev.filter((s) => s.id !== sourceId));
        setPeaksBySource((prev) => {
            if (!prev.has(sourceId)) return prev;
            const next = new Map(prev);
            next.delete(sourceId);
            return next;
        });
        peaksCallbacksRef.current.delete(sourceId);
        queryTokensRef.current.delete(sourceId);
    }, []);

    // Pair up .bam/.bai files picked via the "+" tab by matching filename (minus extension),
    // then hand matched pairs to the existing loader. Reports any file left unmatched.
    const handleAddFilesChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
        const fileList = e.target.files;
        if (!fileList || fileList.length === 0) return;

        const byBase = new Map<string, { bamFile?: File; baiFile?: File }>();
        for (const f of Array.from(fileList)) {
            const lower = f.name.toLowerCase();
            if (lower.endsWith(".bai")) {
                const base = f.name.replace(/\.bam\.bai$/i, "").replace(/\.bai$/i, "");
                const entry = byBase.get(base) ?? {};
                entry.baiFile = f;
                byBase.set(base, entry);
            } else if (lower.endsWith(".bam")) {
                const base = f.name.replace(/\.bam$/i, "");
                const entry = byBase.get(base) ?? {};
                entry.bamFile = f;
                byBase.set(base, entry);
            }
        }

        const pairs: { bamFile: File; baiFile: File }[] = [];
        const unmatched: string[] = [];
        for (const [base, entry] of byBase) {
            if (entry.bamFile && entry.baiFile) pairs.push({ bamFile: entry.bamFile, baiFile: entry.baiFile });
            else unmatched.push(base);
        }

        if (pairs.length > 0) handleBamBaiFiles(pairs);
        if (unmatched.length > 0) setStatus(`Missing matching .bam or .bai for: ${unmatched.join(", ")}`);

        e.target.value = "";
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [handleBamBaiFiles]);

    // Keep the active tab valid as sources are added/removed.
    useEffect(() => {
        setActiveSourceId((cur) => {
            if (cur && sources.some((s) => s.id === cur)) return cur;
            return sources[0]?.id ?? null;
        });
    }, [sources]);

    const toggleLock = useCallback((sourceId: string) => {
        setSources((prev) => prev.map((s) => (s.id === sourceId ? { ...s, locked: !s.locked } : s)));
    }, []);

    const handlePanelViewChange = useCallback((sourceId: string, next: { start: number; end: number }) => {
        setSources((prev) => {
            const source = prev.find((s) => s.id === sourceId);
            if (source?.locked) setSharedView(next);
            return prev;
        });
    }, []);

    const handlePeaksChange = useCallback((sourceId: string, peaks: Map<string, number>) => {
        setPeaksBySource((prev) => {
            const next = new Map(prev);
            next.set(sourceId, peaks);
            return next;
        });
    }, []);

    // Stable per-source callback identity (AlignmentCanvas only re-reports peaks when its own
    // values change, so this doesn't need to change every render to avoid a report/re-render loop).
    function getPeaksCallback(sourceId: string) {
        let fn = peaksCallbacksRef.current.get(sourceId);
        if (!fn) {
            fn = (peaks: Map<string, number>) => handlePeaksChange(sourceId, peaks);
            peaksCallbacksRef.current.set(sourceId, fn);
        }
        return fn;
    }

    const sharedPeaks = useMemo(() => {
        const merged = new Map<string, number>();
        for (const peaks of peaksBySource.values()) {
            for (const [id, v] of peaks) merged.set(id, Math.max(merged.get(id) ?? 0, v));
        }
        return merged;
    }, [peaksBySource]);

    function reorder(draggedId: string, targetId: string) {
        if (draggedId === targetId) return;
        setSources((prev) => {
            const next = [...prev];
            const fromIdx = next.findIndex((s) => s.id === draggedId);
            const toIdx = next.findIndex((s) => s.id === targetId);
            if (fromIdx === -1 || toIdx === -1) return prev;
            const [moved] = next.splice(fromIdx, 1);
            next.splice(toIdx, 0, moved);
            return next;
        });
    }

    function handleHeaderDragStart(id: string) {
        return (e: DragEvent<HTMLDivElement>) => {
            setDragId(id);
            e.dataTransfer.effectAllowed = "move";
        };
    }

    function handleHeaderDragOver(id: string) {
        return (e: DragEvent<HTMLDivElement>) => {
            if (!dragId || dragId === id) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setDropTargetId(id);
        };
    }

    function handleHeaderDrop(id: string) {
        return (e: DragEvent<HTMLDivElement>) => {
            e.preventDefault();
            if (dragId) reorder(dragId, id);
            setDragId(null);
            setDropTargetId(null);
        };
    }

    function handleHeaderDragEnd() {
        setDragId(null);
        setDropTargetId(null);
    }

    // Re-run automatically for any BAM that finishes loading while a gene is already selected
    useEffect(() => {
        if (!currentGeneId) return;
        for (const s of sources) {
            if (s.ready && s.records === null && !s.queryLoading && !s.queryError) runQuery(currentGeneId, s.id, exonIndexById);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sources.map((s) => s.id + s.ready).join(",")]);

    const currentGene = currentGeneId ? exonIndexById.get(currentGeneId) ?? null : null;
    const viewingGene = viewingGeneId ? exonIndexById.get(viewingGeneId) ?? null : null;
    const lockableCount = sources.length;

    function renderPanel(source: BamSource, gene: ExonGene) {
        return (
            <AlignmentPanel
                label={source.label}
                gene={gene}
                records={source.records}
                loading={source.queryLoading}
                error={source.queryError}
                exonIndexById={exonIndexById}
                locked={source.locked}
                sharedView={sharedView}
                onViewChange={(v) => handlePanelViewChange(source.id, v)}
                sharedPeaks={sharedPeaks}
                onPeaksChange={getPeaksCallback(source.id)}
                onToggleLock={() => toggleLock(source.id)}
                showLock={viewMode === "grid" && lockableCount > 1}
                draggable={viewMode === "grid" && lockableCount > 1}
                isDragging={dragId === source.id}
                isDropTarget={dropTargetId === source.id && dragId !== source.id}
                onHeaderDragStart={handleHeaderDragStart(source.id)}
                onHeaderDragOver={handleHeaderDragOver(source.id)}
                onHeaderDragLeave={() => setDropTargetId((cur) => (cur === source.id ? null : cur))}
                onHeaderDrop={handleHeaderDrop(source.id)}
                onHeaderDragEnd={handleHeaderDragEnd}
            />
        );
    }

    return (
        <>
            <Header
                exonFileName={exonFileName}
                bamFileLabel={bamFileLabel}
                exonIndexReady={exonIndexById.size > 0}
                exonIndexById={exonIndexById}
                status={status}
                onExonIndexFile={handleExonIndexFile}
                onBamBaiFiles={handleBamBaiFiles}
                onSelectGene={handleSelectGene}
            />
            <Legend />

            {currentGene && (
                <>
                    <p id="geneTitle">
                        {currentGene.name && currentGene.name !== currentGene.id ? `${currentGene.name} (${currentGene.id})` : currentGene.id}
                    </p>
                    <p id="geneSubtitle">
                        {currentGene.chrom}:{currentGene.start.toLocaleString()}-{currentGene.end.toLocaleString()}
                    </p>
                </>
            )}

            {sources.length > 0 && (
                <BamTabStrip
                    sources={sources.map((s) => ({ id: s.id, label: s.label, ready: s.ready, queryError: s.queryError }))}
                    activeId={activeSourceId}
                    viewMode={viewMode}
                    onSelect={setActiveSourceId}
                    onClose={removeSource}
                    onAddClick={() => addFileInputRef.current?.click()}
                    onViewModeChange={setViewMode}
                />
            )}
            <input
                ref={addFileInputRef}
                type="file"
                accept=".bam,.bai"
                multiple
                style={{ display: "none" }}
                onChange={handleAddFilesChange}
            />

            {viewingGene && sources.length > 0 ? (
                <div id="panelArea">
                    {viewMode === "single" || sources.length === 1 ? (
                        <div className="single-panel-wrap">
                            {renderPanel(sources.find((s) => s.id === activeSourceId) ?? sources[0], viewingGene)}
                        </div>
                    ) : (
                        <Group orientation="vertical" className="panel-grid-outer">
                            {(() => {
                                const rows = computeRows(sources.length);
                                let offset = 0;
                                const rowNodes: ReactNode[] = [];
                                rows.forEach((rowCount, rowIdx) => {
                                    const rowSources = sources.slice(offset, offset + rowCount);
                                    offset += rowCount;
                                    if (rowIdx > 0) rowNodes.push(<Separator key={`vsep-${rowIdx}`} className="resize-separator resize-separator-vertical" />);
                                    rowNodes.push(
                                        <Panel key={`row-${rowIdx}`} minSize="15" className="panel-row">
                                            <Group orientation="horizontal" className="panel-grid-row">
                                                {rowSources.map((s, i) => {
                                                    const nodes: ReactNode[] = [];
                                                    if (i > 0) nodes.push(<Separator key={`hsep-${s.id}`} className="resize-separator resize-separator-horizontal" />);
                                                    nodes.push(
                                                        <Panel key={s.id} minSize="15" className="panel-col">
                                                            {renderPanel(s, viewingGene)}
                                                        </Panel>,
                                                    );
                                                    return nodes;
                                                })}
                                            </Group>
                                        </Panel>,
                                    );
                                });
                                return rowNodes;
                            })()}
                        </Group>
                    )}
                </div>
            ) : (
                <div id="placeholder">
                    Load an exon index (from build_exon_index.py) to get an instant, searchable gene list with
                    coordinates. Then load one or more BAM files together with their .bai. Selecting a gene queries
                    just that region through each index - no need to scan the whole file - and shows the known
                    transcript models alongside the actual reads, side by side across BAM files.
                </div>
            )}
        </>
    );
}
