import React, { useState, useEffect, useRef } from "react";

/**
 * Red pill that surfaces backend errors (currently MLB Stats API failures
 * during MiLB season-totals fetches). Click → lightbox with error details
 * + a "Copy Error Details" button that ships a Claude-Code-friendly JSON
 * dump to the clipboard.
 *
 * Auto-clears on next successful fetch — the parent passes a fresh `errors`
 * array on every refetch, and an empty array hides the pill.
 *
 * Props:
 *   errors:  array of error dicts: { source, message, url, status, timestamp }
 *   context: any extra context (pitcher_id, season, view) shipped in the
 *            copy payload so we can reproduce
 */
export default function ErrorPill({ errors, context }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef(null);

  useEffect(() => () => {
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
  }, []);

  if (!errors || errors.length === 0) return null;

  const handleCopy = async () => {
    const payload = {
      copied_at: new Date().toISOString(),
      url: window.location.href,
      user_agent: navigator.userAgent,
      context: context || null,
      errors,
    };
    const text = JSON.stringify(payload, null, 2);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // Fallback for older browsers / non-secure contexts
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopied(false), 1800);
    } catch (e) {
      console.error("Copy failed", e);
    }
  };

  const summary = errors.length === 1
    ? "1 fetch error"
    : `${errors.length} fetch errors`;

  return (
    <>
      <button
        type="button"
        className="error-pill"
        onClick={() => setOpen(true)}
        title="Click for error details"
      >
        <span className="error-pill-dot" aria-hidden="true">●</span>
        <span>{summary}</span>
      </button>

      {open && (
        <div
          className="error-lightbox-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Error details"
          onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
        >
          <div className="error-lightbox">
            <div className="error-lightbox-header">
              <span className="error-lightbox-title">Backend fetch errors</span>
              <button
                type="button"
                className="error-lightbox-close"
                onClick={() => setOpen(false)}
                aria-label="Close"
              >×</button>
            </div>

            <div className="error-lightbox-body">
              <div className="error-lightbox-summary">
                {errors.length} error{errors.length === 1 ? "" : "s"} during the
                last fetch. Auto-clears on next successful refresh.
              </div>
              <ol className="error-list">
                {errors.map((err, i) => (
                  <li key={i} className="error-list-item">
                    <div className="error-source">
                      <code>{err.source || "unknown"}</code>
                      {err.status != null ? <span className="error-status"> · HTTP {err.status}</span> : null}
                      {err.timestamp ? <span className="error-ts"> · {err.timestamp}</span> : null}
                    </div>
                    <div className="error-msg">{err.message}</div>
                    {err.url ? <div className="error-url"><code>{err.url}</code></div> : null}
                  </li>
                ))}
              </ol>
            </div>

            <div className="error-lightbox-footer">
              <button
                type="button"
                className={`copy-error-btn${copied ? " copied" : ""}`}
                onClick={handleCopy}
              >
                {copied ? "Copied to clipboard ✓" : "Copy Error Details"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
