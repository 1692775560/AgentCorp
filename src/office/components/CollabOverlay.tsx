/**
 * CollabOverlay — SVG layer drawn over the office canvas.
 *
 * Renders animated dashed lines between agents that are collaborating on the
 * same file. Lines pulse with a traveling dash animation and a color derived
 * from the "intensity" of the collaboration.
 *
 * Coordinate transform:
 *   canvas device-pixel coords → CSS pixel coords by dividing by DPR.
 *   character CSS centre = (offsetX/dpr + ch.x * zoom/dpr, offsetY/dpr + ch.y * zoom/dpr)
 */
import { useEffect, useRef } from 'react';

import type { OfficeState } from '../engine/officeState.js';
import type { ToolActivity } from '../types.js';
import { TILE_SIZE } from '../types.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CollabLink {
  fromId: number;
  toId: number;
  /** File path both agents are touching */
  filePath: string;
  /** Intensity 0-1 (drives line opacity + width) */
  intensity: number;
  /** Colour based on relationship type */
  color: string;
}

export interface RenderContext {
  offsetX: number;  // device pixels
  offsetY: number;
  zoom: number;
  dpr: number;
}

interface CollabOverlayProps {
  officeState: OfficeState;
  links: CollabLink[];
  /** Ref written each frame by OfficeCanvas with current render context */
  renderContextRef: React.MutableRefObject<RenderContext | null>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function characterCSSCenter(
  id: number,
  officeState: OfficeState,
  ctx: RenderContext,
): { x: number; y: number } | null {
  const ch = officeState.characters.get(id);
  if (!ch) return null;
  const { offsetX, offsetY, zoom, dpr } = ctx;
  // ch.x / ch.y are world-pixel coords (TILE_SIZE units * zoom = device pixels)
  // Centre of the character sprite (feet level - half sprite height ≈ 8px sprite * zoom)
  const spriteHalfH = (TILE_SIZE * 0.5) * zoom / dpr;
  return {
    x: offsetX / dpr + ch.x * zoom / dpr,
    y: offsetY / dpr + ch.y * zoom / dpr - spriteHalfH,
  };
}

// ── Main component ────────────────────────────────────────────────────────────

export function CollabOverlay({ officeState, links, renderContextRef }: CollabOverlayProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const animRef = useRef<number>(0);
  const tickRef = useRef(0);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    function frame() {
      animRef.current = requestAnimationFrame(frame);
      tickRef.current += 0.8; // drive dash animation

      const ctx = renderContextRef.current;
      if (!ctx || !svg) return;

      // Clear all existing paths
      while (svg.firstChild) svg.removeChild(svg.firstChild);

      if (links.length === 0) return;

      const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');

      links.forEach((link, i) => {
        const from = characterCSSCenter(link.fromId, officeState, ctx);
        const to   = characterCSSCenter(link.toId,   officeState, ctx);
        if (!from || !to) return;

        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 4) return;

        const gradId = `collab-grad-${i}`;

        // Gradient along the line direction
        const grad = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
        grad.setAttribute('id', gradId);
        grad.setAttribute('x1', String(from.x));
        grad.setAttribute('y1', String(from.y));
        grad.setAttribute('x2', String(to.x));
        grad.setAttribute('y2', String(to.y));
        grad.setAttribute('gradientUnits', 'userSpaceOnUse');
        const stop1 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
        stop1.setAttribute('offset', '0%');
        stop1.setAttribute('stop-color', link.color);
        stop1.setAttribute('stop-opacity', String(link.intensity * 0.9));
        const stop2 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
        stop2.setAttribute('offset', '100%');
        stop2.setAttribute('stop-color', link.color);
        stop2.setAttribute('stop-opacity', String(link.intensity * 0.4));
        grad.appendChild(stop1);
        grad.appendChild(stop2);
        defs.appendChild(grad);

        // Glow line (wider, more transparent)
        const glow = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        glow.setAttribute('x1', String(from.x));
        glow.setAttribute('y1', String(from.y));
        glow.setAttribute('x2', String(to.x));
        glow.setAttribute('y2', String(to.y));
        glow.setAttribute('stroke', link.color);
        glow.setAttribute('stroke-width', String(3 + link.intensity * 3));
        glow.setAttribute('stroke-opacity', String(link.intensity * 0.12));
        glow.setAttribute('stroke-linecap', 'round');
        svg.appendChild(glow);

        // Main dashed line
        const dashLen = 6 + dist * 0.04;
        const gapLen  = 4 + dist * 0.02;
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        path.setAttribute('x1', String(from.x));
        path.setAttribute('y1', String(from.y));
        path.setAttribute('x2', String(to.x));
        path.setAttribute('y2', String(to.y));
        path.setAttribute('stroke', `url(#${gradId})`);
        path.setAttribute('stroke-width', String(1.5 + link.intensity));
        path.setAttribute('stroke-dasharray', `${dashLen} ${gapLen}`);
        path.setAttribute('stroke-dashoffset', String(-(tickRef.current % (dashLen + gapLen))));
        path.setAttribute('stroke-linecap', 'round');
        svg.appendChild(path);

        // Traveling dot (a small circle that moves along the line)
        const t = ((tickRef.current * 0.004) % 1 + 1) % 1;
        const dotX = from.x + dx * t;
        const dotY = from.y + dy * t;
        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute('cx', String(dotX));
        dot.setAttribute('cy', String(dotY));
        dot.setAttribute('r', String(2.5 + link.intensity));
        dot.setAttribute('fill', link.color);
        dot.setAttribute('opacity', String(link.intensity * 0.9));
        svg.appendChild(dot);

        // File label at midpoint
        const mx = (from.x + to.x) / 2;
        const my = (from.y + to.y) / 2 - 8;
        const fileName = link.filePath.split('/').pop() ?? link.filePath;
        const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        label.setAttribute('x', String(mx));
        label.setAttribute('y', String(my));
        label.setAttribute('text-anchor', 'middle');
        label.setAttribute('fill', link.color);
        label.setAttribute('font-size', '7');
        label.setAttribute('font-family', "'Press Start 2P', monospace");
        label.setAttribute('opacity', String(link.intensity * 0.8));
        label.textContent = fileName;
        svg.appendChild(label);
      });

      svg.insertBefore(defs, svg.firstChild);
    }

    animRef.current = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(animRef.current);
  }, [links, officeState, renderContextRef]);

  return (
    <svg
      ref={svgRef}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: 5,
        overflow: 'visible',
      }}
    />
  );
}

// ── Derive collab links from agent tools ──────────────────────────────────────

const DEPT_COLORS: Record<string, string> = {
  'backend-api':   '#60a5fa',
  'design-system': '#a78bfa',
  'qa-automation': '#4ade80',
  'product-specs': '#fbbf24',
  'ops-infra':     '#f87171',
};

/**
 * Scan active tool statuses for shared files and produce CollabLink[].
 * Two agents "collaborate" when they both have a recent tool on the same
 * file path (one writing + one reading, or same dept sub-agents).
 */
export function deriveCollabLinks(
  agents: number[],
  agentTools: Record<number, ToolActivity[]>,
  officeState: OfficeState,
): CollabLink[] {
  // Build file → agentId[] mapping from active tools
  const fileAgents = new Map<string, number[]>();

  for (const id of agents) {
    const tools = agentTools[id] ?? [];
    for (const t of tools) {
      if (t.done) continue;
      // Extract file path from status strings like "Writing src/routes/auth.ts"
      const match = t.status.match(/(?:Reading|Writing|Editing|Globbing)\s+(\S+)/);
      if (!match) continue;
      const filePath = match[1];
      const list = fileAgents.get(filePath) ?? [];
      if (!list.includes(id)) list.push(id);
      fileAgents.set(filePath, list);
    }
  }

  const links: CollabLink[] = [];
  const seen = new Set<string>();

  for (const [filePath, ids] of fileAgents) {
    if (ids.length < 2) continue;
    // Pair up every two agents touching this file
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const key = `${ids[i]}-${ids[j]}-${filePath}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const chFrom = officeState.characters.get(ids[i]);
        const color = DEPT_COLORS[chFrom?.folderName ?? ''] ?? '#c2ef4e';

        links.push({
          fromId: ids[i],
          toId: ids[j],
          filePath,
          intensity: 0.85,
          color,
        });
      }
    }
  }

  // Also link sub-agents to their parent
  for (const id of agents) {
    const ch = officeState.characters.get(id);
    if (!ch?.isSubagent || ch.parentAgentId == null) continue;
    if (!agents.includes(ch.parentAgentId)) continue;
    const key = `sub-${ch.parentAgentId}-${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({
      fromId: ch.parentAgentId,
      toId: id,
      filePath: '(sub-agent)',
      intensity: 0.6,
      color: '#a78bfa',
    });
  }

  return links;
}
