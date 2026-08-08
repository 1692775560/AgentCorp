/**
 * DepartmentOverlay — floating, clickable department chips over the office.
 *
 * Each chip floats above the centroid of its area, shows only the department
 * glyph + name + live agent count (never *what* they're doing), and gently
 * bobs. Clicking a chip opens the DepartmentPanel for that department.
 *
 * Positioning reuses the same renderContextRef coordinate system as
 * CollabOverlay / TaskBadgeOverlay: CSS px = offset/dpr + tile*TILE_SIZE*zoom/dpr.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import type { RenderContext } from './CollabOverlay.js';
import type { OfficeState } from '../engine/officeState.js';
import { TILE_SIZE } from '../types.js';
import { DEPARTMENTS, getDepartment } from '../companyStructure.js';
import { candidatesByArea } from '../../components/candidates.js';

interface DepartmentOverlayProps {
  officeState: OfficeState;
  renderContextRef: React.MutableRefObject<RenderContext | null>;
  /** agentId → area label (which department each live agent sits in) */
  agentAreas: Record<number, string | null>;
  /** Called when a department chip is clicked */
  onOpenDepartment: (label: string) => void;
}

interface Centroid { label: string; tileCol: number; tileRow: number; }

/** Compute each area's centroid (in tile coords) from the layout's areaTiles. */
function computeCentroids(officeState: OfficeState): Centroid[] {
  const layout = officeState.getLayout();
  const { areaTiles, cols } = layout;
  if (!areaTiles || !cols) return [];
  const acc = new Map<string, { sx: number; sy: number; n: number }>();
  for (let i = 0; i < areaTiles.length; i++) {
    const label = areaTiles[i];
    if (!label) continue;
    const r = Math.floor(i / cols);
    const c = i % cols;
    const a = acc.get(label);
    if (a) { a.sx += c; a.sy += r; a.n += 1; }
    else acc.set(label, { sx: c, sy: r, n: 1 });
  }
  const out: Centroid[] = [];
  for (const [label, a] of acc) {
    if (!getDepartment(label)) continue; // only known departments
    out.push({ label, tileCol: a.sx / a.n, tileRow: a.sy / a.n });
  }
  return out;
}

export function DepartmentOverlay({
  officeState, renderContextRef, agentAreas, onOpenDepartment,
}: DepartmentOverlayProps) {
  // Centroids only depend on the layout — recompute when layout revision bumps.
  const layoutRev = officeState.getLayout().layoutRevision ?? 0;
  const centroids = useMemo(
    () => computeCentroids(officeState),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layoutRev],
  );

  // 每个部门的 agent 计数：优先用候选花名册真相源（candidatesByArea），
  // 同时叠加真实注入/连接的 agent（agentAreas），保证与部门面板一致、可靠。
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    // 真实 agent（座位反查）
    for (const area of Object.values(agentAreas)) {
      if (area) m[area] = (m[area] ?? 0) + 1;
    }
    // 若座位反查为空，退回候选真相源，确保部门数与面板一致
    for (const label of Object.keys(DEPARTMENTS)) {
      if (!m[label]) m[label] = candidatesByArea(label).length;
    }
    return m;
  }, [agentAreas]);

  // Positions are updated imperatively each frame via refs, so the chips track
  // pan/zoom without React re-renders.
  const chipRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const animRef = useRef<number>(0);
  const tickRef = useRef(0);
  const [hovered, setHovered] = useState<string | null>(null);

  useEffect(() => {
    function frame() {
      animRef.current = requestAnimationFrame(frame);
      tickRef.current += 1;
      const ctx = renderContextRef.current;
      if (!ctx) return;
      const { offsetX, offsetY, zoom, dpr } = ctx;
      const t = tickRef.current;

      for (const cen of centroids) {
        const el = chipRefs.current.get(cen.label);
        if (!el) continue;
        const cx = offsetX / dpr + (cen.tileCol + 0.5) * TILE_SIZE * zoom / dpr;
        const cy = offsetY / dpr + (cen.tileRow + 0.5) * TILE_SIZE * zoom / dpr
          - 4 * Math.sin(t * 0.04); // gentle bob
        el.style.transform = `translate(-50%, -50%) translate(${cx}px, ${cy}px)`;
      }
    }
    animRef.current = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(animRef.current);
  }, [centroids, renderContextRef]);

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 7 }}>
      <style>{`
        @keyframes deptChipPulse {
          0%,100% { box-shadow: 0 0 0 rgba(0,0,0,0); }
          50% { box-shadow: 0 0 12px var(--dept-glow); }
        }
      `}</style>
      {centroids.map((cen) => {
        const dept = DEPARTMENTS[cen.label];
        if (!dept) return null;
        const n = counts[cen.label] ?? 0;
        const isHover = hovered === cen.label;
        return (
          <div
            key={cen.label}
            ref={(el) => { if (el) chipRefs.current.set(cen.label, el); }}
            onClick={() => onOpenDepartment(cen.label)}
            onMouseEnter={() => setHovered(cen.label)}
            onMouseLeave={() => setHovered(null)}
            style={{
              position: 'absolute', top: 0, left: 0,
              // transform set imperatively each frame
              pointerEvents: 'auto',
              cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '4px 10px',
              background: isHover ? `${dept.color}28` : 'rgba(15,10,26,.86)',
              border: `2px solid ${dept.color}`,
              borderRadius: 3,
              boxShadow: isHover ? `0 0 14px ${dept.color}66` : `2px 2px 0 #05020a`,
              fontFamily: "'Press Start 2P', monospace",
              color: dept.color,
              whiteSpace: 'nowrap',
              transition: 'background 120ms, box-shadow 120ms',
              animation: 'deptChipPulse 3.2s ease-in-out infinite',
              // @ts-expect-error custom property for the keyframe glow
              '--dept-glow': `${dept.color}55`,
              userSelect: 'none',
            }}
            title={`打开 ${dept.nameZh} — 组织架构 / 任务 / A2A 协议`}
          >
            <span style={{ fontSize: 12 }}>{dept.glyph}</span>
            <span className="notranslate" translate="no" style={{ fontSize: 8, letterSpacing: 0.5 }}>{dept.nameZh}</span>
            {/* Live agent count badge — shows presence, not activity */}
            <span style={{
              fontSize: 7,
              background: `${dept.color}22`,
              border: `1px solid ${dept.color}`,
              borderRadius: 8,
              padding: '1px 5px',
              color: dept.color,
            }}>
              {n} ●
            </span>
          </div>
        );
      })}
    </div>
  );
}
