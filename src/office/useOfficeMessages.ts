/**
 * src/office/useOfficeMessages.ts
 * 像素办公室消息消费 hook（AgentCorp 精简版）。
 *
 * 原 pixel-agents 由 useExtensionMessages（~600 行）消费 VS Code 扩展主进程经 transport
 * 下发的 window MessageEvent。AgentCorp 内嵌场景改由 browserMock.dispatchMockMessages
 * 在本地 dispatch 同样的 window 事件，本 hook 只处理「渲染像素办公室 + 让 agent 入座」
 * 真正需要的消息子集，不引入任何 webview / 扩展依赖：
 *   资源：characterSpritesLoaded / floorTilesLoaded / wallTilesLoaded /
 *         carpetTilesLoaded / furnitureAssetsLoaded
 *   布局：layoutLoaded（rebuildFromLayout；在此之前到达的 agentCreated 会被缓冲）
 *   角色：agentCreated（os.addAgent，按 folderName 落到对应部门区域）/ agentClosed
 *
 * 座位区域映射（folderName → area label）由 /office 页面在 dispatch 前
 * 经 officeState.setAreaMappings 配置。
 */
import { useEffect } from 'react';

import { setCharacterTemplates } from './sprites/spriteData.js';
import { setFloorSprites } from './floorTiles.js';
import { setWallSprites } from './wallTiles.js';
import { setCarpetSprites } from './sprites/carpetTiles.js';
import { buildDynamicCatalog } from './layout/furnitureCatalog.js';
import type { OfficeState } from './engine/officeState.js';
import type { OfficeLayout } from './types.js';

interface PendingAgent {
  id: number;
  palette?: number;
  hueShift?: number;
  folderName?: string;
}

interface Msg {
  type?: string;
  [k: string]: unknown;
}

/**
 * 挂载 window message 监听，把 browserMock 派发的资源/布局/agent 事件落到 officeState。
 * @param officeState 目标像素办公室状态
 * @param onReady     资源+布局就绪、agent 已入座后回调（用于触发一次 re-render / 记录）
 */
export function useOfficeMessages(
  officeState: OfficeState,
  onReady?: () => void,
): void {
  useEffect(() => {
    const os = officeState;
    let layoutReady = false;
    let pending: PendingAgent[] = [];

    function seat(a: PendingAgent) {
      os.addAgent(a.id, a.palette, a.hueShift, undefined, undefined, a.folderName);
    }

    function handle(ev: MessageEvent) {
      const msg = ev.data as Msg;
      if (!msg || typeof msg.type !== 'string') return;

      switch (msg.type) {
        case 'characterSpritesLoaded':
          setCharacterTemplates(msg.characters as never);
          break;
        case 'floorTilesLoaded':
          setFloorSprites(msg.sprites as never);
          break;
        case 'wallTilesLoaded':
          setWallSprites(msg.sets as never);
          break;
        case 'carpetTilesLoaded':
          setCarpetSprites(msg.sets as never);
          break;
        case 'furnitureAssetsLoaded':
          buildDynamicCatalog({
            catalog: msg.catalog as never,
            sprites: msg.sprites as never,
          });
          break;
        case 'layoutLoaded': {
          const layout = (msg.layout as OfficeLayout | null) ?? null;
          if (layout) os.rebuildFromLayout(layout);
          // 布局（及座位）就绪后，把缓冲的 agent 依次入座
          for (const a of pending) seat(a);
          pending = [];
          layoutReady = true;
          onReady?.();
          break;
        }
        case 'agentCreated': {
          const a: PendingAgent = {
            id: msg.id as number,
            palette: msg.palette as number | undefined,
            hueShift: msg.hueShift as number | undefined,
            folderName: msg.folderName as string | undefined,
          };
          if (layoutReady) seat(a);
          else pending.push(a); // 布局未就绪先缓冲
          break;
        }
        case 'agentClosed': {
          const id = msg.id as number;
          os.removeAgent?.(id);
          break;
        }
        default:
          break;
      }
    }

    window.addEventListener('message', handle);
    return () => window.removeEventListener('message', handle);
  }, [officeState, onReady]);
}
