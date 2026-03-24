import React, { useState, useRef, useEffect } from "react";
import { PITCH_COLORS } from "../constants";

/**
 * Generic checkbox-dropdown for filtering pitches.
 * mode = "pitch-type" | "pitch-result"
 *
 * Props:
 *  - options: string[]          — available option labels
 *  - selected: Set<string>      — currently-selected option labels
 *  - onChange: (Set<string>) =>  — called when selection changes
 *  - label: string              — button label text
 *  - quickActions: { label, fn(currentSet, allOptions) => newSet }[]
 *  - columns: number            — # of grid columns (default 1)
 *  - colorMap: { [label]: color } — optional dot colors
 *  - isMobile: boolean          — mobile mode (forces single column)
 */
export default function PitchFilterDropdown({
  options, selected, onChange, label, quickActions, columns = 1, colorMap, menuHeader, isMobile,
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const allSelected = options.length > 0 && options.every(o => selected.has(o));
  const noneSelected = selected.size === 0;
  const someFiltered = !allSelected && !noneSelected;

  const toggle = (opt) => {
    const next = new Set(selected);
    if (next.has(opt)) next.delete(opt);
    else next.add(opt);
    onChange(next);
  };

  const selectAll = () => onChange(new Set(options));
  const deselectAll = () => onChange(new Set());

  return (
    <div className="pf-dropdown" ref={ref}>
      <button
        className={`pf-dropdown-btn${someFiltered ? " pf-filtered" : ""}`}
        onClick={() => setOpen(!open)}
      >
        {label}
        {someFiltered && <span className="pf-badge">{selected.size}</span>}
      </button>
      {open && (
        <div className={`pf-menu${!isMobile && columns > 1 ? " pf-multi-col" : ""}`}>
          {menuHeader && <div className="pf-menu-header">{menuHeader}</div>}
          <div className="pf-quick-row">
            <span className="pf-quick" onClick={selectAll}>All</span>
            <span className="pf-quick" onClick={deselectAll}>None</span>
            {quickActions?.map((qa, i) => (
              <span key={i} className="pf-quick" onClick={() => onChange(qa.fn(selected, options))}>{qa.label}</span>
            ))}
          </div>
          <div className="pf-options" style={columns > 1 ? { gridTemplateColumns: `repeat(${columns}, 1fr)` } : undefined}>
            {options.map(opt => (
              <label key={opt} className="pf-option" onClick={() => toggle(opt)}>
                <span className={`pf-check${selected.has(opt) ? " pf-checked" : ""}`}>
                  {selected.has(opt) ? "✓" : ""}
                </span>
                {colorMap?.[opt] && (
                  <span className="pf-color-dot" style={{ background: colorMap[opt] }} />
                )}
                <span className="pf-opt-label">{opt}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
