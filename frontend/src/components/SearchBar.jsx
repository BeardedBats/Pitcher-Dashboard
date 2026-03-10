import React, { useState, useRef, useEffect } from "react";

const API = window.__BACKEND_PORT__
  ? `http://localhost:${window.__BACKEND_PORT__}`
  : process.env.NODE_ENV === "development" ? "http://localhost:8000" : "";

export default function SearchBar({ onSelectPlayer }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef(null);
  const wrapperRef = useRef(null);

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
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!val.trim()) {
      setResults([]);
      setOpen(false);
      return;
    }
    timerRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`${API}/api/pitchers-search?q=${encodeURIComponent(val)}`);
        const data = await res.json();
        setResults(data);
        setOpen(true);
      } catch (err) {
        console.error("Search error:", err);
      }
      setLoading(false);
    }, 300);
  };

  const handleSelect = (pitcher) => {
    setQuery("");
    setResults([]);
    setOpen(false);
    onSelectPlayer(pitcher.pitcher_id, pitcher.name);
  };

  const handleKeyDown = (e) => {
    if (e.key === "Escape") {
      setOpen(false);
      e.target.blur();
    }
  };

  return (
    <div className="search-bar" ref={wrapperRef}>
      <input
        type="text"
        className="search-input"
        placeholder="Search pitchers..."
        value={query}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onFocus={() => { if (results.length > 0) setOpen(true); }}
      />
      {open && results.length > 0 && (
        <div className="search-dropdown">
          {results.map((p) => (
            <div key={p.pitcher_id} className="search-result" onClick={() => handleSelect(p)}>
              <span className="search-result-name">{p.name}</span>
              <span className="search-result-meta">
                {p.teams.join("/")} · {p.hand === "R" ? "RHP" : "LHP"}
              </span>
            </div>
          ))}
        </div>
      )}
      {open && results.length === 0 && query.trim() && !loading && (
        <div className="search-dropdown">
          <div className="search-result search-no-results">No pitchers found</div>
        </div>
      )}
    </div>
  );
}
