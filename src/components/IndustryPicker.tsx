"use client";

import { useState } from "react";
import { INDUSTRY_PRESETS } from "@/core/search/industries";

interface IndustryPickerProps {
  value: string[];
  onChange: (tags: string[]) => void;
  disabled?: boolean;
}

export default function IndustryPicker({
  value,
  onChange,
  disabled = false,
}: IndustryPickerProps) {
  const [customInput, setCustomInput] = useState("");

  const togglePreset = (label: string) => {
    if (disabled) return;
    if (value.includes(label)) {
      onChange(value.filter((t) => t !== label));
    } else {
      onChange([...value, label]);
    }
  };

  const removeTag = (tag: string) => {
    if (disabled) return;
    onChange(value.filter((t) => t !== tag));
  };

  const handleAddCustom = () => {
    const trimmed = customInput.trim();
    if (!trimmed || value.includes(trimmed)) {
      setCustomInput("");
      return;
    }
    onChange([...value, trimmed]);
    setCustomInput("");
  };

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span className="dim" style={{ fontSize: 11 }}>
          相关行业分类（可选，可多选；不选即搜索全行业）
        </span>
        {value.length > 0 && !disabled && (
          <button
            type="button"
            className="dim"
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              fontSize: 11,
              padding: 0,
              color: "var(--accent)",
            }}
            onClick={() => onChange([])}
          >
            清空已选
          </button>
        )}
      </div>

      {/* 预设行业标签 */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
        {INDUSTRY_PRESETS.map((preset) => {
          const selected = value.includes(preset.label);
          return (
            <button
              key={preset.key}
              type="button"
              className="badge"
              disabled={disabled}
              onClick={() => togglePreset(preset.label)}
              style={{
                cursor: disabled ? "not-allowed" : "pointer",
                color: selected ? "var(--accent)" : "var(--fg-dim)",
                borderColor: selected ? "#1f6feb66" : "var(--border)",
                background: selected ? "#1f6feb15" : "transparent",
                fontWeight: selected ? 600 : "normal",
                transition: "all 0.15s ease",
              }}
              title={`点击${selected ? "取消" : "选择"}：${preset.label}`}
            >
              {preset.label}
            </button>
          );
        })}
      </div>

      {/* 自定义行业输入与已选自定义标签 */}
      <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 8 }}>
        <input
          className="input"
          style={{
            flex: 1,
            padding: "3px 8px",
            fontSize: 12,
            minWidth: 120,
          }}
          placeholder="自填其他行业标签，按回车添加"
          value={customInput}
          onChange={(e) => setCustomInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleAddCustom();
            }
          }}
          disabled={disabled}
        />
        <button
          type="button"
          className="btn"
          style={{ padding: "3px 10px", fontSize: 12 }}
          onClick={handleAddCustom}
          disabled={disabled || !customInput.trim()}
        >
          添加
        </button>
      </div>

      {/* 活跃的非预设自定义标签 */}
      {value.filter((t) => !INDUSTRY_PRESETS.some((p) => p.label === t)).length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 6 }}>
          {value
            .filter((t) => !INDUSTRY_PRESETS.some((p) => p.label === t))
            .map((tag) => (
              <span
                key={tag}
                className="badge"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  color: "var(--accent)",
                  background: "#1f6feb15",
                  borderColor: "#1f6feb66",
                  fontSize: 11,
                }}
              >
                {tag}
                {!disabled && (
                  <button
                    type="button"
                    onClick={() => removeTag(tag)}
                    style={{
                      border: "none",
                      background: "none",
                      color: "inherit",
                      cursor: "pointer",
                      padding: "0 2px",
                      fontSize: 12,
                      lineHeight: 1,
                    }}
                    title="移除"
                  >
                    ×
                  </button>
                )}
              </span>
            ))}
        </div>
      )}
    </div>
  );
}
