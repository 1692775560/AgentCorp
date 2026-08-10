/**
 * TaskBadgeOverlay — SVG layer that draws task status bubbles above agent heads.
 *
 * States and icons:
 *   pending  → 📋 clipboard, pulsing border
 *   running  → ⚙  gear, spinning
 *   done     → ✓  checkmark, green flash then fade
 *   error    → ✗  cross, red
 *
 * Shares the same renderContextRef coordinate system as CollabOverlay
 * (device-pixel offsetX/Y → CSS pixels by ÷ DPR).
 */
import { useEffect, useRef } from 'react';

import type { RenderContext } from './CollabOverlay.js';
import type { AgentTaskStatus } from '../_deps/webviewStubs.js';
import type { OfficeState } from '../engine/officeState.js';
import { TILE_SIZE } from '../types.js';

interface TaskBadgeOverlayProps {
  officeState: OfficeState;
  taskStatuses: Map<number, AgentTaskStatus>;
  renderContextRef: React.MutableRefObject<RenderContext | null>;
  /** Designated boss/orchestrator agent id — gets a persistent crown */
  bossAgentId?: number | null;
}

const STATE_ICON: Record<string, string>  = { pending: '📋', running: '⚙', done: '✓', error: '✗' };
const STATE_COLOR: Record<string, string> = {
  pending: '#60a5fa',
  running: '#fbbf24',
  done:    '#34d399',
  error:   '#f87171',
};

export function TaskBadgeOverlay({ officeState, taskStatuses, renderContextRef, bossAgentId }: TaskBadgeOverlayProps) {
  const svgRef  = useRef<SVGSVGElement>(null);
  const animRef = useRef<number>(0);
  const tickRef = useRef(0);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    function frame() {
      animRef.current = requestAnimationFrame(frame);
      tickRef.current += 1;

      const ctx = renderContextRef.current;
      if (!ctx || !svg) return;
      while (svg.firstChild) svg.removeChild(svg.firstChild);

      const { offsetX, offsetY, zoom, dpr } = ctx;
      const t = tickRef.current;

      // ── Persistent crown above the boss/orchestrator ──
      if (bossAgentId != null) {
        const boss = officeState.characters.get(bossAgentId);
        if (boss) {
          const spriteHalfH = (TILE_SIZE * 1.5) * zoom / dpr;
          const bx = offsetX / dpr + boss.x * zoom / dpr;
          const by = offsetY / dpr + boss.y * zoom / dpr - spriteHalfH - 26
            - 2 * Math.sin(t * 0.06); // gentle bob
          const crown = document.createElementNS('http://www.w3.org/2000/svg', 'text');
          crown.setAttribute('x', String(bx));
          crown.setAttribute('y', String(by));
          crown.setAttribute('text-anchor', 'middle');
          crown.setAttribute('font-size', '16');
          crown.textContent = '👑';
          svg.appendChild(crown);
        }
      }

      if (taskStatuses.size === 0) return;

      for (const [agentId, ts] of taskStatuses) {
        const ch = officeState.characters.get(agentId);
        if (!ch) continue;

        // Head position in CSS px (same as CollabOverlay)
        const spriteHalfH = (TILE_SIZE * 1.5) * zoom / dpr;
        const cx = offsetX / dpr + ch.x * zoom / dpr;
        const cy = offsetY / dpr + ch.y * zoom / dpr - spriteHalfH - 10;

        const color = STATE_COLOR[ts.state] ?? '#c2ef4e';
        const icon  = STATE_ICON[ts.state]  ?? '?';
        const isRunning = ts.state === 'running';
        const isPending = ts.state === 'pending';
        const isDone    = ts.state === 'done';

        // Pulse / spin amplitude
        const pulse = isPending ? 0.85 + 0.15 * Math.sin(t * 0.08) : 1;
        const opacity = isDone
          ? Math.max(0, 1 - (ts.completedAt ? (Date.now() - ts.completedAt) / 8000 : 0))
          : 1;

        if (opacity <= 0) continue;

        // ── Bubble background ──
        const bw = 44, bh = 20;
        const bx = cx - bw / 2, by = cy - bh;

        const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        bg.setAttribute('x', String(bx));
        bg.setAttribute('y', String(by));
        bg.setAttribute('width', String(bw));
        bg.setAttribute('height', String(bh));
        bg.setAttribute('rx', '3');
        bg.setAttribute('fill', `${color}18`);
        bg.setAttribute('stroke', color);
        bg.setAttribute('stroke-width', String(isPending ? 1.5 * pulse : 1.5));
        bg.setAttribute('opacity', String(opacity));
        svg.appendChild(bg);

        // ── Tail triangle ──
        const tail = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
        const tx = cx;
        tail.setAttribute('points',
          `${tx - 4},${by + bh} ${tx + 4},${by + bh} ${tx},${by + bh + 5}`);
        tail.setAttribute('fill', `${color}18`);
        tail.setAttribute('stroke', color);
        tail.setAttribute('stroke-width', '1');
        tail.setAttribute('opacity', String(opacity));
        svg.appendChild(tail);

        // ── Icon (spinning gear for running) ──
        const iconEl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        const spin = isRunning ? (t * 6) % 360 : 0;
        const iconX = bx + 8, iconY = by + 13;
        if (isRunning) {
          iconEl.setAttribute('transform', `rotate(${spin},${iconX},${iconY - 3})`);
        }
        iconEl.setAttribute('x', String(iconX));
        iconEl.setAttribute('y', String(iconY));
        iconEl.setAttribute('font-size', '10');
        iconEl.setAttribute('opacity', String(opacity));
        iconEl.textContent = icon;
        svg.appendChild(iconEl);

        // ── Task label (truncated) ──
        const maxChars = 12;
        const label = ts.label.length > maxChars ? ts.label.slice(0, maxChars) + '…' : ts.label;
        const labelEl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        labelEl.setAttribute('x', String(bx + 20));
        labelEl.setAttribute('y', String(by + 13));
        labelEl.setAttribute('fill', color);
        labelEl.setAttribute('font-size', '6');
        labelEl.setAttribute('font-family', "'Press Start 2P', monospace");
        labelEl.setAttribute('opacity', String(opacity * 0.9));
        labelEl.textContent = label;
        svg.appendChild(labelEl);
      }
    }

    animRef.current = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(animRef.current);
  }, [taskStatuses, officeState, renderContextRef, bossAgentId]);

  return (
    <svg
      ref={svgRef}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: 6,   // just above CollabOverlay (z=5)
        overflow: 'visible',
      }}
    />
  );
}
