import React, { useState, useRef, useEffect } from "react";

const API_BASE = window.__BACKEND_PORT__
  ? `http://localhost:${window.__BACKEND_PORT__}`
  : process.env.NODE_ENV === "development" ? "http://localhost:8000" : "";

/**
 * Server-side pitcher search backed by /api/pitchers-search.
 * Returns the actual pitchers in the season's data (level-aware).
 * The endpoint is accent-insensitive on the server side.
 */
export default function SearchBar({ onSelectPlayer, level = "mlb" }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const wrapperRef = useRef(null);
  const reqIdRef = useRef(0);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Debounced server search — 150ms feels responsive without flooding the API.
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      setOpen(false);
      return;
    }
    const myReqId = ++reqIdRef.current;
    const t = setTimeout(() => {
      const params = new URLSearchParams({ q: trimmed });
      if (level && level !== "mlb") params.set("level", level);
      fetch(`${API_BASE}/api/pitchers-search?${params}`)
        .then((r) => r.json())
        .then((data) => {
          // Drop stale responses
          if (myReqId !== reqIdRef.current) return;
          const list = Array.isArray(data) ? data : [];
          setResults(list);
          setOpen(true);
          setHighlightIdx(-1);
        })
        .catch(() => {
          if (myReqId !== reqIdRef.current) return;
          setResults([]);
          setOpen(true);
        });
    }, 150);
    return () => clearTimeout(t);
  }, [query, level]);

  const handleSelect = (player, e) => {
    setQuery("");
    setResults([]);
    setOpen(false);
    setHighlightIdx(-1);
    // Server already gave us the pitcher_id — pass it directly.
    onSelectPlayer(player.pitcher_id, player.name, e);
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
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={() => { if (results.length > 0) setOpen(true); }}
      />
      {open && results.length > 0 && (
        <div className="search-dropdown">
          {results.map((p, idx) => (
            <div
              key={p.pitcher_id}
              className={`search-result${idx === highlightIdx ? " highlighted" : ""}`}
              onClick={(e) => handleSelect(p, e)}
              onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); handleSelect(p, e); } }}
            >
              <span className="search-result-name">{p.name}</span>
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
