import React from "react";
export default function DatePicker({ date, onChange }) {
  return (
    <div className="date-picker">
      <input type="date" value={date || ""} onChange={e => onChange(e.target.value)} />
    </div>
  );
}
