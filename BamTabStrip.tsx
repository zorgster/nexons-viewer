import "./BamTabStrip.css";

export type ViewMode = "single" | "grid";

export interface BamTabInfo {
    id: string;
    label: string;
    ready: boolean;
    queryError: string | null;
}

interface BamTabStripProps {
    sources: BamTabInfo[];
    activeId: string | null;
    viewMode: ViewMode;
    onSelect: (id: string) => void;
    onClose: (id: string) => void;
    onAddClick: () => void;
    onViewModeChange: (mode: ViewMode) => void;
}

export default function BamTabStrip({
    sources,
    activeId,
    viewMode,
    onSelect,
    onClose,
    onAddClick,
    onViewModeChange,
}: BamTabStripProps) {
    return (
        <div className="bam-tab-strip">
            <div className="bam-tab-list" role="tablist">
                {sources.map((source) => (
                    <div
                        key={source.id}
                        role="tab"
                        aria-selected={source.id === activeId}
                        className={`bam-tab ${source.id === activeId ? "active" : ""} ${source.queryError ? "has-error" : ""}`}
                        onClick={() => onSelect(source.id)}
                        title={source.queryError ?? source.label}
                    >
                        <span className="bam-tab-label">{source.label}</span>
                        <button
                            type="button"
                            className="bam-tab-close"
                            aria-label={`Remove ${source.label}`}
                            onClick={(event) => {
                                event.stopPropagation();
                                onClose(source.id);
                            }}
                        >
                            <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
                                <path d="M2 2 L10 10 M10 2 L2 10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                            </svg>
                        </button>
                    </div>
                ))}

                <button type="button" className="bam-tab-add" aria-label="Add BAM file" onClick={onAddClick}>
                    <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
                        <path d="M6 1 V11 M1 6 H11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                    </svg>
                </button>
            </div>

            {sources.length > 1 && (
                <div className="bam-view-toggle" role="group" aria-label="View mode">
                    <button
                        type="button"
                        className={`bam-view-toggle-btn ${viewMode === "single" ? "active" : ""}`}
                        aria-pressed={viewMode === "single"}
                        onClick={() => onViewModeChange("single")}
                        title="Single view"
                    >
                        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                            <rect x="1.5" y="1.5" width="13" height="13" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
                        </svg>
                    </button>
                    <button
                        type="button"
                        className={`bam-view-toggle-btn ${viewMode === "grid" ? "active" : ""}`}
                        aria-pressed={viewMode === "grid"}
                        onClick={() => onViewModeChange("grid")}
                        title="Split / grid view"
                    >
                        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                            <rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" />
                            <rect x="9" y="1.5" width="5.5" height="5.5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" />
                            <rect x="1.5" y="9" width="5.5" height="5.5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" />
                            <rect x="9" y="9" width="5.5" height="5.5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" />
                        </svg>
                    </button>
                </div>
            )}
        </div>
    );
}
