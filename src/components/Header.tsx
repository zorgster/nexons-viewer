// Copyright (C) 2026 Oliver Slay and Simon Andrews
// SPDX-License-Identifier: GPL-3.0-only

import type { ChangeEvent } from "react";

export type LayoutMode = 1 | 2 | 4;

interface HeaderProps {
    exonFileName: string;
    gtfProgress: number | null;
    bamFileLabel: string;
    onboardingStep: "gtf" | "bam" | null;
    status: string;
    tslLevel: string;
    onTslLevelChange: (level: string) => void;
    onExonIndexFile: (file: File) => void;
    onBamBaiFiles: (pairs: { bamFile: File; baiFile: File }[]) => void;
    layoutMode: LayoutMode;
    onLayoutModeChange: (mode: LayoutMode) => void;
}

const LAYOUT_OPTIONS: { mode: LayoutMode; label: string; title: string }[] = [
    { mode: 1, label: "1", title: "Single panel" },
    { mode: 2, label: "2×1", title: "2 panels side by side" },
    { mode: 4, label: "2×2", title: "4 panels, 2 rows of 2" },
];

export default function Header({
    exonFileName,
    gtfProgress,
    bamFileLabel,
    onboardingStep,
    status,
    tslLevel,
    onTslLevelChange,
    onExonIndexFile,
    onBamBaiFiles,
    layoutMode,
    onLayoutModeChange,
}: HeaderProps) {
    function handleExonInput(e: ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        if (file) onExonIndexFile(file);
        e.target.value = "";
    }

    function handleBamBaiInput(e: ChangeEvent<HTMLInputElement>) {
        const files = [...(e.target.files ?? [])];
        const bams = files.filter((file) => /\.bam$/i.test(file.name));
        const bais = files.filter((file) => /\.bai$/i.test(file.name));
        const pairs = bams.map((bamFile) => {
            const expectedNames = new Set([`${bamFile.name}.bai`, bamFile.name.replace(/\.bam$/i, ".bai")]);
            const baiFile = bais.find((file) => expectedNames.has(file.name));
            return baiFile ? { bamFile, baiFile } : null;
        }).filter((pair): pair is { bamFile: File; baiFile: File } => pair !== null);

        if (pairs.length !== bams.length || pairs.length === 0) {
            window.alert("Select each BAM together with its matching BAI file");
        } else {
            onBamBaiFiles(pairs);
        }
        e.target.value = "";
    }

    return (
        <header>
            <img className="app-logo" src={`${import.meta.env.BASE_URL}nexons_viewer_logo_path.svg`} alt="Nexons read viewer" />

            <label className="tsl-label" htmlFor="tslSelect">
                Max TSL:
                <select
                    id="tslSelect"
                    value={tslLevel}
                    onChange={(e) => onTslLevelChange(e.target.value)}
                    title="Transcript support level filter (applies when loading a .gtf file)"
                >
                    <option value="all">All</option>
                    <option value="1">1</option>
                    <option value="2">2</option>
                    <option value="3">3</option>
                    <option value="4">4</option>
                    <option value="5">5</option>
                </select>
            </label>

            <label
                className={`file-label${gtfProgress !== null ? " file-label-progress" : ""}${onboardingStep === "gtf" ? " onboarding-highlight" : ""}`}
                data-onboarding-hint={onboardingStep === "gtf" ? "Start here: load a GTF file." : undefined}
                htmlFor="exonInput"
            >
                {gtfProgress !== null && (
                    <span className="progress-fill" style={{ width: `${Math.min(100, Math.round(gtfProgress * 100))}%` }} />
                )}
                <span className="file-label-text">
                    {gtfProgress !== null
                        ? `Parsing… ${Math.round(gtfProgress * 100)}%`
                        : exonFileName
                            ? `GTF: ${exonFileName}`
                            : "Select GTF File"}
                </span>
                <input type="file" id="exonInput" accept=".json,.gtf,.gtf.txt,.gtf.gz,.gz" disabled={gtfProgress !== null} onChange={handleExonInput} />
            </label>

            <label
                className={`file-label${onboardingStep === "bam" ? " onboarding-highlight" : ""}`}
                data-onboarding-hint={onboardingStep === "bam" ? "Next: select each BAM together with its matching BAI file." : undefined}
                htmlFor="bamBaiInput"
            >
                BAM + BAI: <span className="fname">{bamFileLabel}</span>
                <input type="file" id="bamBaiInput" accept=".bam,.bai" multiple onChange={handleBamBaiInput} />
            </label>

            <div className="layout-toggle" role="group" aria-label="Panel layout">
                {LAYOUT_OPTIONS.map((opt) => (
                    <button
                        key={opt.mode}
                        type="button"
                        className={"layout-btn" + (layoutMode === opt.mode ? " active" : "")}
                        title={opt.title}
                        onClick={() => onLayoutModeChange(opt.mode)}
                    >
                        {opt.label}
                    </button>
                ))}
            </div>

            <div id="status">{status}</div>
        </header>
    );
}
