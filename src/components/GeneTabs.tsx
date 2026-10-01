// Copyright (C) 2026 Oliver Slay and Simon Andrews
// SPDX-License-Identifier: GPL-3.0-only

import { useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import type { ExonGene } from "../types";

export interface GeneTab {
    id: string;
    geneId: string;
}

interface GeneTabsProps {
    tabs: GeneTab[];
    activeTabId: string | null;
    addressBarOpen: boolean;
    exonIndexById: Map<string, ExonGene>;
    exonIndexReady: boolean;
    showAddGeneHint: boolean;
    onSelectTab: (id: string) => void;
    onCloseTab: (id: string) => void;
    onOpenAddressBar: () => void;
    onCloseAddressBar: () => void;
    onPickGene: (geneId: string) => void;
}

export default function GeneTabs({
    tabs,
    activeTabId,
    addressBarOpen,
    exonIndexById,
    exonIndexReady,
    showAddGeneHint,
    onSelectTab,
    onCloseTab,
    onOpenAddressBar,
    onCloseAddressBar,
    onPickGene,
}: GeneTabsProps) {
    const [query, setQuery] = useState("");
    const [showSuggestions, setShowSuggestions] = useState(false);
    const [activeIndex, setActiveIndex] = useState(-1);
    const activeSuggestionRef = useRef<HTMLDivElement>(null);

    const matches = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (q.length < 1) return [];
        return [...exonIndexById.values()]
            .filter((g) => g.id.toLowerCase().startsWith(q) || (g.name && g.name.toLowerCase().startsWith(q)))
            .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id))
            .slice(0, 20);
    }, [query, exonIndexById]);

    const suggestionsVisible = showSuggestions && matches.length > 0;

    useEffect(() => {
        if (suggestionsVisible) activeSuggestionRef.current?.scrollIntoView({ block: "nearest" });
    }, [activeIndex, suggestionsVisible]);

    function pickGene(g: ExonGene) {
        setQuery("");
        setShowSuggestions(false);
        setActiveIndex(-1);
        onPickGene(g.id);
    }

    function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
        if (e.nativeEvent.isComposing) return;
        if (suggestionsVisible && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            setActiveIndex((current) => {
                if (current < 0) return e.key === "ArrowDown" ? 0 : matches.length - 1;
                return (current + (e.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length;
            });
        } else if (suggestionsVisible && e.key === "Enter" && matches[activeIndex]) {
            e.preventDefault();
            pickGene(matches[activeIndex]);
        }
        if (e.key === "Escape") {
            setQuery("");
            setShowSuggestions(false);
            setActiveIndex(-1);
            onCloseAddressBar();
        }
    }

    return (
        <div id="geneTabs">
            <div className="tab-strip">
                {tabs.map((tab) => {
                    const gene = exonIndexById.get(tab.geneId);
                    const title = gene && gene.name && gene.name !== gene.id ? `${gene.name} (${gene.id})` : (gene?.id ?? tab.geneId);
                    const coords = gene ? `${gene.chrom}:${gene.start.toLocaleString()}-${gene.end.toLocaleString()}` : "";
                    return (
                        <div
                            key={tab.id}
                            className={"gene-tab" + (tab.id === activeTabId ? " active" : "")}
                            onClick={() => onSelectTab(tab.id)}
                        >
                            <span className="gene-tab-label" title={title}>{title}</span>
                            {coords && <span className="gene-tab-coords">{coords}</span>}
                            <button
                                type="button"
                                className="gene-tab-close"
                                onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id); }}
                                title="Close tab"
                            >
                                ×
                            </button>
                        </div>
                    );
                })}
                <button
                    type="button"
                    className={"gene-tab-add" + (tabs.length === 0 ? " gene-tab-add-empty" : "") + (showAddGeneHint ? " onboarding-highlight onboarding-highlight-right" : "")}
                    data-onboarding-hint={showAddGeneHint ? "Finally: click + to choose a gene to view." : undefined}
                    onClick={onOpenAddressBar}
                    title="Open a gene in a new tab"
                >
                    +
                </button>
            </div>
            {addressBarOpen && (
                <div id="geneAddressBarWrap">
                    <input
                        id="geneAddressBar"
                        type="text"
                        placeholder={exonIndexReady ? "Gene ID or name" : "Load a GTF first…"}
                        disabled={!exonIndexReady}
                        autoComplete="off"
                        role="combobox"
                        aria-label="Gene ID or name"
                        aria-autocomplete="list"
                        aria-expanded={suggestionsVisible}
                        aria-controls={suggestionsVisible ? "suggestions" : undefined}
                        aria-activedescendant={suggestionsVisible && matches[activeIndex] ? `gene-suggestion-${activeIndex}` : undefined}
                        autoFocus
                        value={query}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => { setQuery(e.target.value); setShowSuggestions(true); setActiveIndex(-1); }}
                        onKeyDown={handleKeyDown}
                        onBlur={() => window.setTimeout(() => setShowSuggestions(false), 150)}
                    />
                    {suggestionsVisible && (
                        <div id="suggestions" role="listbox" aria-label="Gene suggestions">
                            {matches.map((g, index) => (
                                <div
                                    id={`gene-suggestion-${index}`}
                                    className={"row" + (index === activeIndex ? " active" : "")}
                                    key={g.id}
                                    ref={index === activeIndex ? activeSuggestionRef : null}
                                    role="option"
                                    aria-selected={index === activeIndex}
                                    onMouseEnter={() => setActiveIndex(index)}
                                    onMouseDown={(e) => e.preventDefault()}
                                    onClick={() => pickGene(g)}
                                >
                                    <span>
                                        {g.name && g.name !== g.id ? (
                                            <>{g.name} <span className="sugg-meta">{g.id}</span></>
                                        ) : (
                                            g.id
                                        )}{" "}
                                        <span className="sugg-meta">{g.chrom}:{g.start}-{g.end}</span>
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
