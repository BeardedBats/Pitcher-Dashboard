import React, { useState, useRef, useEffect, useMemo } from "react";
import { TOP_400_NAMES } from "../top400";

/**
 * Client-side search against the Top 400 pitcher list.
 * Uses Unicode NFKD normalization to strip diacritics so that
 * "Vasquez" matches "Vásquez" and vice versa.
 */
function stripAccents(str) {
  return str.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/\u00ad/g, "");
}

export default function SearchBar({ onSelectPlayer }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const wrapperRef = useRef(null);

  // Build searchable list once from the Top 400 set
  const searchList = useMemo(() => {
    return Array.from(TOP_400_NAMES).map((name) => ({
      name,
      normalized: stripAccents(name).toLowerCase(),
    }));
  }, []);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleChange = (e) => {
    const val = e.target.value;
    setQuery(val);
    setHighlightIdx(-1);
    if (!val.trim()) {
      setResults([]);
      setOpen(false);
      return;
    }
    const q = stripAccents(val).toLowerCase();
    const matches = searchList
      .filter((item) => item.normalized.includes(q))
      .slice(0, 15);
    setResults(matches.map((m) => m.name));
    setOpen(matches.length > 0);
  };

  const handleSelect = (name, e) => {
    setQuery("");
    setResults([]);
    setOpen(false);
    setHighlightIdx(-1);
    // Pass name instead of pitcher_id — App.jsx navigateToPlayer handles name-based lookup
    onSelectPlayer(null, name, e);
  };

  const handleKeyDown = (e) => {
    if (e.key === "Escape") {
      setOpen(false);
      e.target.blur();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIdx((prev) => Math.min(prev + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIdx((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Enter" && highlightIdx >= 0 && highlightIdx < results.length) {
      e.preventDefault();
      handleSelect(results[highlightIdx], e);
    }
  };

  return (
    <div className="search-bar" ref={wrapperRef}>
      <input
        type="text"
        className="search-input"
        placeholder="Player Search"
        value={query}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onFocus={() => { if (results.length > 0) setOpen(true); }}
      />
      {open && results.length > 0 && (
        <div className="search-dropdown">
          {results.map((name, idx) => (
            <div
              key={name}
              className={`search-result${idx === highlightIdx ? " highlighted" : ""}`}
              onClick={(e) => handleSelect(name, e)}
              onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); handleSelect(name, e); } }}
            >
              <span className="search-result-name">{name}</span>
            </div>
          ))}
        </div>
      )}
      {open && results.length === 0 && query.trim() && (
        <div className="search-dropdown">
          <div className="search-result search-no-results">No pitchers found</div>
        </div>
      )}
    </div>
  );
}
