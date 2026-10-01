// Copyright (C) 2026 Oliver Slay and Simon Andrews
// SPDX-License-Identifier: GPL-3.0-only

export default function Legend() {
    return (
        <div id="legend">
            <div className="legend-row">
                <div className="group">
                    <span className="item"><i className="box style-unique" /> unique</span>
                    <span className="item"><i className="box style-partial" /> partial</span>
                    <span className="item"><i className="box style-gene" /> gene-level only</span>
                </div>
                <div className="sep" />
                <div className="group">
                    <span className="item"><i className="box colour-current-gene" /> current gene</span>
                    <span className="item"><i className="box colour-other-gene" /> other gene</span>
                    <span className="item"><i className="box colour-no-gene" /> multi-gene / no hit</span>
                </div>
                <div className="sep" />
                <div className="group">
                    <span className="item"><i className="box" style={{ background: "#7c3aed", width: 3 }} /> insertion</span>
                    <span className="item"><i className="box" style={{ background: "#1f2933", height: 2 }} /> deletion</span>
                </div>
            </div>
        </div>
    );
}
