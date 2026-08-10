/**
 * Browser runtime mock — fetches assets and injects the same postMessage
 * events the VS Code extension would send.
 *
 * In Vite dev, it prefers pre-decoded JSON endpoints from middleware.
 * In plain browser builds, it falls back to decoding PNGs at runtime.
 *
 * Only imported in browser runtime; tree-shaken from VS Code webview runtime.
 */

import { rgbaToHex } from './_deps/assets/colorUtils.js';
import {
  CHAR_FRAME_H,
  CHAR_FRAME_W,
  CHAR_FRAMES_PER_ROW,
  CHARACTER_DIRECTIONS,
  FLOOR_TILE_SIZE,
  WALL_BITMASK_COUNT,
  WALL_GRID_COLS,
  WALL_PIECE_HEIGHT,
  WALL_PIECE_WIDTH,
} from './_deps/assets/constants.js';
import type {
  AssetIndex,
  CatalogEntry,
  CharacterDirectionSprites,
} from './_deps/assets/types.js';

interface MockPayload {
  characters: CharacterDirectionSprites[];
  floorSprites: string[][][];
  wallSets: string[][][][];
  carpetSets: string[][][][];
  furnitureCatalog: CatalogEntry[];
  furnitureSprites: Record<string, string[][]>;
  layout: unknown;
}

// ── Module-level state ─────────────────────────────────────────────────────────

let mockPayload: MockPayload | null = null;

// ── PNG decode helpers (browser fallback) ───────────────────────────────────

interface DecodedPng {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

function getPixel(
  data: Uint8ClampedArray,
  width: number,
  x: number,
  y: number,
): [number, number, number, number] {
  const idx = (y * width + x) * 4;
  return [data[idx], data[idx + 1], data[idx + 2], data[idx + 3]];
}

function readSprite(
  png: DecodedPng,
  width: number,
  height: number,
  offsetX = 0,
  offsetY = 0,
): string[][] {
  const sprite: string[][] = [];
  for (let y = 0; y < height; y++) {
    const row: string[] = [];
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = getPixel(png.data, png.width, offsetX + x, offsetY + y);
      row.push(rgbaToHex(r, g, b, a));
    }
    sprite.push(row);
  }
  return sprite;
}

async function decodePng(url: string): Promise<DecodedPng> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch PNG: ${url} (${res.status.toString()})`);
  }
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    throw new Error('Failed to create 2d canvas context for PNG decode');
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { width: canvas.width, height: canvas.height, data: imageData.data };
}

async function fetchJsonOptional<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function getIndexedAssetPath(kind: 'characters' | 'floors' | 'walls', relPath: string): string {
  return relPath.startsWith(`${kind}/`) ? relPath : `${kind}/${relPath}`;
}

async function decodeCharactersFromPng(
  base: string,
  index: AssetIndex,
): Promise<CharacterDirectionSprites[]> {
  const sprites: CharacterDirectionSprites[] = [];
  for (const relPath of index.characters) {
    const png = await decodePng(`${base}office-assets/${getIndexedAssetPath('characters', relPath)}`);
    const byDir: CharacterDirectionSprites = { down: [], up: [], right: [] };

    for (let dirIdx = 0; dirIdx < CHARACTER_DIRECTIONS.length; dirIdx++) {
      const dir = CHARACTER_DIRECTIONS[dirIdx];
      const rowOffsetY = dirIdx * CHAR_FRAME_H;
      const frames: string[][][] = [];
      for (let frame = 0; frame < CHAR_FRAMES_PER_ROW; frame++) {
        frames.push(readSprite(png, CHAR_FRAME_W, CHAR_FRAME_H, frame * CHAR_FRAME_W, rowOffsetY));
      }
      byDir[dir] = frames;
    }

    sprites.push(byDir);
  }
  return sprites;
}

async function decodeFloorsFromPng(base: string, index: AssetIndex): Promise<string[][][]> {
  const floors: string[][][] = [];
  for (const relPath of index.floors) {
    const png = await decodePng(`${base}office-assets/${getIndexedAssetPath('floors', relPath)}`);
    floors.push(readSprite(png, FLOOR_TILE_SIZE, FLOOR_TILE_SIZE));
  }
  return floors;
}

async function decodeWallsFromPng(base: string, index: AssetIndex): Promise<string[][][][]> {
  const wallSets: string[][][][] = [];
  for (const relPath of index.walls) {
    const png = await decodePng(`${base}office-assets/${getIndexedAssetPath('walls', relPath)}`);
    const set: string[][][] = [];
    for (let mask = 0; mask < WALL_BITMASK_COUNT; mask++) {
      const ox = (mask % WALL_GRID_COLS) * WALL_PIECE_WIDTH;
      const oy = Math.floor(mask / WALL_GRID_COLS) * WALL_PIECE_HEIGHT;
      set.push(readSprite(png, WALL_PIECE_WIDTH, WALL_PIECE_HEIGHT, ox, oy));
    }
    wallSets.push(set);
  }
  return wallSets;
}

async function decodeFurnitureFromPng(
  base: string,
  catalog: CatalogEntry[],
): Promise<Record<string, string[][]>> {
  const sprites: Record<string, string[][]> = {};
  for (const entry of catalog) {
    const png = await decodePng(`${base}office-assets/${entry.furniturePath}`);
    sprites[entry.id] = readSprite(png, entry.width, entry.height);
  }
  return sprites;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Call before createRoot() in main.tsx.
 * Fetches all pre-decoded assets from the Vite dev server and stores them
 * for dispatchMockMessages().
 */
export async function initBrowserMock(): Promise<void> {
  console.log('[BrowserMock] Loading assets...');

  const base = import.meta.env.BASE_URL; // '/' in dev, '/sub/' with a subpath, './' in production

  const [assetIndex, catalog] = await Promise.all([
    fetch(`${base}office-assets/asset-index.json`).then((r) => r.json()) as Promise<AssetIndex>,
    fetch(`${base}office-assets/furniture-catalog.json`).then((r) => r.json()) as Promise<CatalogEntry[]>,
  ]);

  const shouldTryDecoded = import.meta.env.DEV;
  const [decodedCharacters, decodedFloors, decodedWalls, decodedFurniture] = shouldTryDecoded
    ? await Promise.all([
        fetchJsonOptional<CharacterDirectionSprites[]>(`${base}office-assets/decoded/characters.json`),
        fetchJsonOptional<string[][][]>(`${base}office-assets/decoded/floors.json`),
        fetchJsonOptional<string[][][][]>(`${base}office-assets/decoded/walls.json`),
        fetchJsonOptional<Record<string, string[][]>>(`${base}office-assets/decoded/furniture.json`),
      ])
    : [null, null, null, null];

  const hasDecoded = !!(decodedCharacters && decodedFloors && decodedWalls && decodedFurniture);

  if (!hasDecoded) {
    if (shouldTryDecoded) {
      console.log('[BrowserMock] Decoded JSON not found, decoding PNG assets in browser...');
    } else {
      console.log('[BrowserMock] Decoding PNG assets in browser...');
    }
  }

  const [characters, floorSprites, wallSets, furnitureSprites] = hasDecoded
    ? [decodedCharacters!, decodedFloors!, decodedWalls!, decodedFurniture!]
    : await Promise.all([
        decodeCharactersFromPng(base, assetIndex),
        decodeFloorsFromPng(base, assetIndex),
        decodeWallsFromPng(base, assetIndex),
        decodeFurnitureFromPng(base, catalog),
      ]);

  const layout = assetIndex.defaultLayout
    ? await fetch(`${base}office-assets/${assetIndex.defaultLayout}`).then((r) => r.json())
    : null;

  // Carpets only have a decoded-JSON endpoint (no PNG fallback / asset-index
  // entry); empty array is fine — the carpet tab just won't render variants.
  const carpetSets =
    (shouldTryDecoded
      ? await fetchJsonOptional<string[][][][]>(`${base}office-assets/decoded/carpets.json`)
      : null) ?? [];

  mockPayload = {
    characters,
    floorSprites,
    wallSets,
    carpetSets,
    furnitureCatalog: catalog,
    furnitureSprites,
    layout,
  };

  console.log(
    `[BrowserMock] Ready (${hasDecoded ? 'decoded-json' : 'browser-png-decode'}) — ${characters.length} chars, ${floorSprites.length} floors, ${wallSets.length} wall sets, ${carpetSets.length} carpets, ${catalog.length} furniture items`,
  );
}

/**
 * AgentCorp 追加：仅派发「资源 + 布局 + 设置」消息（不含 pixel-agents 的 7 个 mock agent）。
 * /office 页面用它加载像素办公室外观后，再用真实入职 agent 自行 dispatch agentCreated。
 */
export function dispatchOfficeAssets(): void {
  if (!mockPayload) return;
  const { characters, floorSprites, wallSets, carpetSets, furnitureCatalog, furnitureSprites, layout } =
    mockPayload;
  function dispatch(data: unknown): void {
    window.dispatchEvent(new MessageEvent('message', { data }));
  }
  dispatch({ type: 'characterSpritesLoaded', characters });
  dispatch({ type: 'floorTilesLoaded', sprites: floorSprites });
  dispatch({ type: 'wallTilesLoaded', sets: wallSets });
  dispatch({ type: 'carpetTilesLoaded', sets: carpetSets });
  dispatch({ type: 'furnitureAssetsLoaded', catalog: furnitureCatalog, sprites: furnitureSprites });
  dispatch({ type: 'layoutLoaded', layout });
  dispatch({ type: 'settingsLoaded', soundEnabled: false, extensionVersion: '1.4.0', lastSeenVersion: '1.3' });
}

/**
 * Call inside a useEffect in App.tsx -- after the window message listener
 * in useExtensionMessages has been registered.
 *
 * Only used in Vite dev mode (npm run dev). In standalone server mode and
 * VS Code mode, the server/extension sends all state over the transport.
 */
export function dispatchMockMessages(): void {
  if (!mockPayload) return;

  const {
    characters,
    floorSprites,
    wallSets,
    carpetSets,
    furnitureCatalog,
    furnitureSprites,
    layout,
  } = mockPayload;

  function dispatch(data: unknown): void {
    window.dispatchEvent(new MessageEvent('message', { data }));
  }

  // Must match the load order defined in CLAUDE.md:
  // characterSpritesLoaded -> floorTilesLoaded -> wallTilesLoaded -> carpetTilesLoaded
  //   -> furnitureAssetsLoaded -> layoutLoaded
  dispatch({ type: 'characterSpritesLoaded', characters });
  dispatch({ type: 'floorTilesLoaded', sprites: floorSprites });
  dispatch({ type: 'wallTilesLoaded', sets: wallSets });
  dispatch({ type: 'carpetTilesLoaded', sets: carpetSets });
  dispatch({ type: 'furnitureAssetsLoaded', catalog: furnitureCatalog, sprites: furnitureSprites });
  dispatch({ type: 'layoutLoaded', layout });
  dispatch({
    type: 'settingsLoaded',
    soundEnabled: false,
    extensionVersion: '1.4.0',
    lastSeenVersion: '1.3',
  });

  // ── Browser-mode mock: simulate a 5-department company workspace ──
  dispatch({
    type: 'workspaceFolders',
    folders: [
      { name: 'backend-api',    path: '/workspace/backend-api' },
      { name: 'design-system',  path: '/workspace/design-system' },
      { name: 'qa-automation',  path: '/workspace/qa-automation' },
      { name: 'product-specs',  path: '/workspace/product-specs' },
      { name: 'ops-infra',      path: '/workspace/ops-infra' },
    ],
  });

  // ── Engineering dept — 2 agents coding backend ──
  dispatch({ type: 'agentCreated', id: 1, palette: 0, hueShift: 20,  folderName: 'backend-api' });
  dispatch({ type: 'agentCreated', id: 2, palette: 1, hueShift: 40,  folderName: 'backend-api' });
  setTimeout(() => {
    dispatch({ type: 'agentToolStart', id: 1, toolId: 't1',  status: 'Writing src/routes/auth.ts', permissionActive: false });
    dispatch({ type: 'agentContextUsage', id: 1, contextTokens: 42000, maxContextTokens: 200000 });
  }, 150);
  // Agent 1: rapid writes merging
  setTimeout(() => dispatch({ type: 'agentToolStart', id: 1, toolId: 't1b', status: 'Writing src/middleware/jwt.ts',  permissionActive: false }), 700);
  setTimeout(() => dispatch({ type: 'agentToolStart', id: 1, toolId: 't1c', status: 'Writing src/utils/hash.ts',     permissionActive: false }), 1300);
  setTimeout(() => dispatch({ type: 'agentToolDone',  id: 1, toolId: 't1c' }), 1800);
  // Agent 2: reads the same file Agent 1 wrote → triggers collab link
  setTimeout(() => dispatch({ type: 'agentToolStart', id: 2, toolId: 't2b', status: 'Reading src/routes/auth.ts', permissionActive: false }), 2400);
  setTimeout(() => {
    dispatch({ type: 'agentToolStart', id: 2, toolId: 't2', status: 'Bash: npm run deploy', permissionActive: true });
    dispatch({ type: 'agentToolPermission', id: 2 });
    dispatch({ type: 'agentContextUsage', id: 2, contextTokens: 118000, maxContextTokens: 200000 });
  }, 350);

  // ── Design dept — 1 agent building UI components ──
  dispatch({ type: 'agentCreated', id: 3, palette: 2, hueShift: 290, folderName: 'design-system' });
  setTimeout(() => {
    dispatch({ type: 'agentToolStart', id: 3, toolId: 't3', status: 'Reading components/Button.tsx', permissionActive: false });
    dispatch({ type: 'agentContextUsage', id: 3, contextTokens: 27000, maxContextTokens: 200000 });
  }, 250);
  setTimeout(() => {
    dispatch({ type: 'agentToolDone',  id: 3, toolId: 't3' });
    dispatch({ type: 'agentToolStart', id: 3, toolId: 't3b', status: 'Writing components/NewChart.tsx', permissionActive: false });
  }, 3200);
  setTimeout(() => dispatch({ type: 'agentToolDone', id: 3, toolId: 't3b' }), 5800);

  // ── QA dept — 1 agent running tests ──
  dispatch({ type: 'agentCreated', id: 4, palette: 3, hueShift: 150, folderName: 'qa-automation' });
  setTimeout(() => {
    dispatch({ type: 'agentToolStart', id: 4, toolId: 't4', status: 'Bash: pytest tests/e2e/', permissionActive: false });
    dispatch({ type: 'agentContextUsage', id: 4, contextTokens: 55000, maxContextTokens: 200000 });
  }, 500);
  setTimeout(() => dispatch({ type: 'agentToolDone', id: 4, toolId: 't4' }), 4500);
  setTimeout(() => {
    dispatch({ type: 'agentToolStart', id: 4, toolId: 't4b', status: 'Searching: failed test patterns', permissionActive: false });
  }, 4800);

  // ── PM dept — 1 agent writing specs ──
  dispatch({ type: 'agentCreated', id: 5, palette: 4, hueShift: 35,  folderName: 'product-specs' });
  setTimeout(() => {
    dispatch({ type: 'agentToolStart', id: 5, toolId: 't5', status: 'Reading docs/PRD-v3.md', permissionActive: false });
    dispatch({ type: 'agentContextUsage', id: 5, contextTokens: 81000, maxContextTokens: 200000 });
  }, 600);
  setTimeout(() => {
    dispatch({ type: 'agentToolDone',  id: 5, toolId: 't5' });
    dispatch({ type: 'agentToolStart', id: 5, toolId: 't5b', status: 'Writing docs/feature-spec.md', permissionActive: false });
  }, 2800);

  // ── Operations dept — 2 agents managing infra ──
  dispatch({ type: 'agentCreated', id: 6, palette: 5, hueShift: 5,   folderName: 'ops-infra' });
  dispatch({ type: 'agentCreated', id: 7, palette: 0, hueShift: 200, folderName: 'ops-infra' });
  setTimeout(() => {
    dispatch({ type: 'agentToolStart', id: 6, toolId: 't6', status: 'Bash: terraform plan', permissionActive: false });
    dispatch({ type: 'agentContextUsage', id: 6, contextTokens: 33000, maxContextTokens: 200000 });
  }, 450);
  setTimeout(() => {
    dispatch({ type: 'agentToolStart', id: 7, toolId: 't7', status: 'Reading k8s/deployment.yaml', permissionActive: false });
    dispatch({ type: 'agentContextUsage', id: 7, contextTokens: 68000, maxContextTokens: 200000 });
  }, 550);
  setTimeout(() => dispatch({ type: 'agentToolDone', id: 6, toolId: 't6' }), 3800);
  setTimeout(() => {
    dispatch({ type: 'agentToolStart', id: 6, toolId: 't6b', status: 'Bash: terraform apply', permissionActive: true });
    dispatch({ type: 'agentToolPermission', id: 6 });
  }, 4000);

  // ── Lifecycle events ──
  setTimeout(() => {
    dispatch({ type: 'agentToolDone', id: 1, toolId: 't1' });
    dispatch({ type: 'agentToolStart', id: 1, toolId: 't1d', status: 'Bash: npm test', permissionActive: false });
  }, 2100);
  setTimeout(() => {
    dispatch({ type: 'agentToolDone', id: 1, toolId: 't1d' });
    dispatch({ type: 'agentStatus', id: 1, status: 'waiting', awaitingInput: true });
  }, 6500);
  setTimeout(() => {
    dispatch({ type: 'agentToolDone', id: 7, toolId: 't7' });
    dispatch({ type: 'agentToolStart', id: 7, toolId: 't7b', status: 'Writing k8s/hpa.yaml', permissionActive: false });
  }, 4200);

  console.log('[BrowserMock] Messages dispatched');
}
