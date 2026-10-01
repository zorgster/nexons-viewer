// Copyright (C) 2026 Oliver Slay and Simon Andrews
// SPDX-License-Identifier: GPL-3.0-only

import type { BamRecord, ExonGene } from "../types";
import AlignmentCanvas from "./AlignmentCanvas";
import type { TranscriptSortMode } from "../transcriptSort";

export interface PanelSourceOption {
    id: string;
    label: string;
}

interface AlignmentPanelProps {
    gene: ExonGene | null;
    sourceOptions: PanelSourceOption[];
    selectedSourceId: string | null;
    onSelectSource: (id: string | null) => void;
    records: BamRecord[] | null;
    loading: boolean;
    error: string | null;
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
    onToggleLock: () => void;
    showLock: boolean;
}

export default function AlignmentPanel({
    gene,
    sourceOptions,
    selectedSourceId,
    onSelectSource,
    records,
    loading,
    error,
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
    onToggleLock,
    showLock,
}: AlignmentPanelProps) {
    return (
        <div className="alignment-panel">
            <div className="alignment-panel-header">
                <select
                    className="panel-source-select"
                    value={selectedSourceId ?? ""}
                    onChange={(e) => onSelectSource(e.target.value === "" ? null : e.target.value)}
                >
                    <option value="">— empty —</option>
                    {sourceOptions.map((s) => (
                        <option key={s.id} value={s.id} title={s.label}>{s.label}</option>
                    ))}
                </select>
                {showLock && (
                    <button
                        type="button"
                        className={"lock-toggle" + (locked ? " locked" : "")}
                        onClick={onToggleLock}
                        title={locked ? "Unlock to explore this panel independently" : "Re-lock to snap back and sync with other panels"}
                    >
                        {locked ? "🔒 Locked" : "🔓 Unlocked"}
                    </button>
                )}
            </div>
            <div className="alignment-panel-body">
                {!selectedSourceId ? (
                    <div className="panel-message">Select a BAM file</div>
                ) : !gene ? (
                    <div className="panel-message">Select a gene</div>
                ) : error ? (
                    <div className="panel-message panel-message-error">{error}</div>
                ) : loading || !records ? (
                    <div className="panel-message">Querying BAM…</div>
                ) : (
                    <AlignmentCanvas
                        gene={gene}
                        records={records}
                        exonIndexById={exonIndexById}
                        locked={locked}
                        sharedView={sharedView}
                        transcriptSortMode={transcriptSortMode}
                        onTranscriptSortModeChange={onTranscriptSortModeChange}
                        transcriptOrder={transcriptOrder}
                        minimumReadCount={minimumReadCount}
                        onMinimumReadCountChange={onMinimumReadCountChange}
                        visibleTranscriptIds={visibleTranscriptIds}
                        onViewChange={onViewChange}
                    />
                )}
            </div>
        </div>
    );
}
