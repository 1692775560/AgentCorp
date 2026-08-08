/**
 * src/pages/Office/PixelOffice.tsx
 * 像素办公室画布容器：装配 OfficeState、加载像素资源/布局、把真实入职 agent
 * 按部门落座、渲染 OfficeCanvas，并在点选角色时回调（用于打开派活抽屉）。
 *
 * 数据流：
 *   computeOfficeRoster（真实）→ rosterToPixelCandidates（含 numId/area）
 *   → officeState.setAreaMappings(buildAreaMappings)（folder→area）
 *   → dispatchOfficeAssets()（像素资源 + 布局）
 *   → 每个 candidate dispatch agentCreated({ id: numId, folderName: dept:Area }）
 *   → useOfficeMessages 消费 → officeState.addAgent 落到对应部门工位。
 */
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';

import { OfficeCanvas } from '@/office/components/OfficeCanvas.js';
import { OfficeState } from '@/office/engine/officeState.js';
import { EditorState } from '@/office/editor/editorState.js';
import { useOfficeMessages } from '@/office/useOfficeMessages.js';
import { initBrowserMock, dispatchOfficeAssets } from '@/office/browserMock.js';
import {
  rosterToPixelCandidates,
  buildAreaMappings,
  areaToFolder,
  setPixelCandidates,
  toAgentId,
  type PixelCandidate,
} from '@/office/officeAdapter.js';
import type { OfficeEmployee } from '@/engine/office/assignment';

interface PixelOfficeProps {
  roster: OfficeEmployee[];
  /** 点选某个像素角色（回传其字符串 agentId），用于打开派活抽屉 */
  onSelectAgent: (agentId: string) => void;
}

const noop = () => {};

export function PixelOffice({ roster, onSelectAgent }: PixelOfficeProps) {
  // OfficeState / EditorState 只在首次构造（引擎是可变对象，跨帧稳定）
  const officeStateRef = useRef<OfficeState | null>(null);
  if (!officeStateRef.current) officeStateRef.current = new OfficeState();
  const officeState = officeStateRef.current;
  const editorStateRef = useRef<EditorState | null>(null);
  if (!editorStateRef.current) editorStateRef.current = new EditorState();

  const panRef = useRef({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [ready, setReady] = useState(false);
  const dispatchedRef = useRef(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // 用户是否手动缩放过；一旦手动缩放，就不再自动 fit（尊重用户操作）
  const userZoomedRef = useRef(false);

  const TILE = 16;

  /**
   * 计算「铺满容器」的缩放：让整张办公室地图在当前容器里尽量大且完整可见
   * （contain 策略，不裁剪）。渲染工作在设备像素下进行，故按 dpr 换算。
   */
  const fitZoom = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const layout = officeState.getLayout();
    if (!layout || !layout.cols || !layout.rows) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = container.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const deviceW = rect.width * dpr;
    const deviceH = rect.height * dpr;
    const mapW = layout.cols * TILE;
    const mapH = layout.rows * TILE;
    // contain：整图可见；留极小边距(0.98)避免贴边裁切
    const next = Math.min(deviceW / mapW, deviceH / mapH) * 0.98;
    if (!Number.isFinite(next) || next <= 0) return;
    panRef.current = { x: 0, y: 0 }; // renderFrame 会据此居中
    setZoom(next);
  }, [officeState]);

  const handleZoomChange = useCallback((z: number) => {
    userZoomedRef.current = true;
    setZoom(z);
  }, []);

  const candidates: PixelCandidate[] = useMemo(
    () => rosterToPixelCandidates(roster),
    [roster],
  );

  // candidatesByArea 的真相源（供 DepartmentOverlay 计数）
  useEffect(() => {
    setPixelCandidates(candidates);
  }, [candidates]);

  // 配置 folder→area 映射（在任何 agentCreated 之前）
  useEffect(() => {
    officeState.setAreaMappings(buildAreaMappings(candidates));
  }, [officeState, candidates]);

  // 监听像素引擎消息（资源/布局/agent）
  const onReady = useCallback(() => setReady(true), []);
  useOfficeMessages(officeState, onReady);

  // 加载资源 → 派发资源/布局 → 派发真实 agent（仅一次）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await initBrowserMock();
      if (cancelled || dispatchedRef.current) return;
      dispatchedRef.current = true;
      dispatchOfficeAssets();
      // 真实入职 agent 入座（folderName = dept:Area，经 areaMappings 落到部门工位）
      for (const c of candidates) {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: {
              type: 'agentCreated',
              id: c.numId,
              palette: c.numId % 6,
              hueShift: (c.numId * 47) % 360,
              folderName: areaToFolder(c.area),
            },
          }),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
    // 仅首次挂载执行；candidates 后续变化的增量入座在下方单独处理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // roster 变化时补充新入职 agent（已就绪后）
  useEffect(() => {
    if (!ready) return;
    for (const c of candidates) {
      if (!officeState.characters.has(c.numId)) {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: {
              type: 'agentCreated',
              id: c.numId,
              palette: c.numId % 6,
              hueShift: (c.numId * 47) % 360,
              folderName: areaToFolder(c.area),
            },
          }),
        );
      }
    }
  }, [ready, candidates, officeState]);

  const handleClick = useCallback(
    (numId: number) => {
      const agentId = toAgentId(numId);
      if (agentId) onSelectAgent(agentId);
    },
    [onSelectAgent],
  );

  // 就绪后自动 fit 一次；容器尺寸变化时（若用户未手动缩放）重新 fit 铺满
  useEffect(() => {
    if (!ready) return;
    const container = containerRef.current;
    if (!container) return;
    // 首次 fit（下一帧，确保布局已就绪并完成首帧渲染）
    const raf = requestAnimationFrame(() => fitZoom());
    const observer = new ResizeObserver(() => {
      if (!userZoomedRef.current) fitZoom();
    });
    observer.observe(container);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [ready, fitZoom]);

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden">
      <OfficeCanvas
        officeState={officeState}
        onClick={handleClick}
        isEditMode={false}
        editorState={editorStateRef.current}
        onEditorTileAction={noop}
        onEditorEraseAction={noop}
        onEditorSelectionChange={noop}
        onDeleteSelected={noop}
        onRotateSelected={noop}
        onDragMove={noop}
        editorTick={0}
        zoom={zoom}
        onZoomChange={handleZoomChange}
        panRef={panRef}
        showAreas
        activeAreaLabel={null}
        onOpenDepartment={noop}
      />
      {!ready && (
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center text-[13px]"
          style={{ color: 'var(--neu-ink-soft)' }}
        >
          正在加载像素办公室…
        </div>
      )}
    </div>
  );
}
