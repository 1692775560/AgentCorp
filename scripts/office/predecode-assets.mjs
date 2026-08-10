/**
 * 预解码像素办公室资源 —— 构建/开发前运行一次。
 *
 * 把 public/office-assets 下的 PNG（角色/地板/墙/地毯/家具）用 sharp 读成
 * 原始 RGBA，再按运行时同样的规则转成 hex 字符串精灵，写到
 * public/office-assets/decoded/*.json。
 *
 * 浏览器加载时（browserMock.ts）会优先 fetch 这些 JSON，命中即跳过
 * 主线程逐像素解码，秒开。
 *
 * 逻辑必须与 src/office/browserMock.ts + _deps/assets/{constants,colorUtils}.ts 完全一致。
 */
import sharp from 'sharp';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(__dirname, '../../public/office-assets');
const OUT = path.join(PUBLIC, 'decoded');

// ── constants.ts 镜像 ──
const PNG_ALPHA_THRESHOLD = 2;
const WALL_PIECE_WIDTH = 16;
const WALL_PIECE_HEIGHT = 32;
const WALL_GRID_COLS = 4;
const WALL_BITMASK_COUNT = 16;
const FLOOR_TILE_SIZE = 16;
const CHARACTER_DIRECTIONS = ['down', 'up', 'right'];
const CHAR_FRAME_W = 16;
const CHAR_FRAME_H = 32;
const CHAR_FRAMES_PER_ROW = 7;
const CARPET_TILE_SIZE = 16;
const CARPET_GRID_COLS = 4;
const CARPET_MARCHING_SQUARES_COUNT = 16;

function rgbaToHex(r, g, b, a) {
  if (a < PNG_ALPHA_THRESHOLD) return '';
  const rgb = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`.toUpperCase();
  if (a >= 255) return rgb;
  return `${rgb}${a.toString(16).padStart(2, '0').toUpperCase()}`;
}

async function decodePng(file) {
  const { data, info } = await sharp(file)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}

function readSprite(png, width, height, offsetX = 0, offsetY = 0) {
  const sprite = [];
  for (let y = 0; y < height; y++) {
    const row = [];
    for (let x = 0; x < width; x++) {
      const idx = ((offsetY + y) * png.width + (offsetX + x)) * 4;
      row.push(rgbaToHex(png.data[idx], png.data[idx + 1], png.data[idx + 2], png.data[idx + 3]));
    }
    sprite.push(row);
  }
  return sprite;
}

const indexedPath = (kind, rel) => (rel.startsWith(`${kind}/`) ? rel : `${kind}/${rel}`);

async function decodeCharacters(index) {
  const out = [];
  for (const rel of index.characters) {
    const png = await decodePng(path.join(PUBLIC, indexedPath('characters', rel)));
    const byDir = { down: [], up: [], right: [] };
    for (let d = 0; d < CHARACTER_DIRECTIONS.length; d++) {
      const rowY = d * CHAR_FRAME_H;
      const frames = [];
      for (let f = 0; f < CHAR_FRAMES_PER_ROW; f++) {
        frames.push(readSprite(png, CHAR_FRAME_W, CHAR_FRAME_H, f * CHAR_FRAME_W, rowY));
      }
      byDir[CHARACTER_DIRECTIONS[d]] = frames;
    }
    out.push(byDir);
  }
  return out;
}

async function decodeFloors(index) {
  const out = [];
  for (const rel of index.floors) {
    const png = await decodePng(path.join(PUBLIC, indexedPath('floors', rel)));
    out.push(readSprite(png, FLOOR_TILE_SIZE, FLOOR_TILE_SIZE));
  }
  return out;
}

async function decodeWalls(index) {
  const out = [];
  for (const rel of index.walls) {
    const png = await decodePng(path.join(PUBLIC, indexedPath('walls', rel)));
    const set = [];
    for (let m = 0; m < WALL_BITMASK_COUNT; m++) {
      const ox = (m % WALL_GRID_COLS) * WALL_PIECE_WIDTH;
      const oy = Math.floor(m / WALL_GRID_COLS) * WALL_PIECE_HEIGHT;
      set.push(readSprite(png, WALL_PIECE_WIDTH, WALL_PIECE_HEIGHT, ox, oy));
    }
    out.push(set);
  }
  return out;
}

async function decodeCarpets() {
  const out = [];
  for (let i = 0; ; i++) {
    const file = path.join(PUBLIC, 'carpets', `carpet_${i}.png`);
    let png;
    try {
      png = await decodePng(file);
    } catch {
      break;
    }
    const set = [];
    for (let m = 0; m < CARPET_MARCHING_SQUARES_COUNT; m++) {
      const ox = (m % CARPET_GRID_COLS) * CARPET_TILE_SIZE;
      const oy = Math.floor(m / CARPET_GRID_COLS) * CARPET_TILE_SIZE;
      set.push(readSprite(png, CARPET_TILE_SIZE, CARPET_TILE_SIZE, ox, oy));
    }
    out.push(set);
  }
  return out;
}

async function decodeFurniture(catalog) {
  const out = {};
  for (const entry of catalog) {
    const png = await decodePng(path.join(PUBLIC, entry.furniturePath));
    out[entry.id] = readSprite(png, entry.width, entry.height);
  }
  return out;
}

async function main() {
  const t0 = Date.now();
  const index = JSON.parse(await readFile(path.join(PUBLIC, 'asset-index.json'), 'utf8'));
  const catalog = JSON.parse(await readFile(path.join(PUBLIC, 'furniture-catalog.json'), 'utf8'));
  await mkdir(OUT, { recursive: true });

  const [characters, floors, walls, carpets, furniture] = await Promise.all([
    decodeCharacters(index),
    decodeFloors(index),
    decodeWalls(index),
    decodeCarpets(),
    decodeFurniture(catalog),
  ]);

  await Promise.all([
    writeFile(path.join(OUT, 'characters.json'), JSON.stringify(characters)),
    writeFile(path.join(OUT, 'floors.json'), JSON.stringify(floors)),
    writeFile(path.join(OUT, 'walls.json'), JSON.stringify(walls)),
    writeFile(path.join(OUT, 'carpets.json'), JSON.stringify(carpets)),
    writeFile(path.join(OUT, 'furniture.json'), JSON.stringify(furniture)),
  ]);

  console.log(
    `[predecode] 完成 ${((Date.now() - t0) / 1000).toFixed(1)}s — ` +
      `${characters.length} 角色, ${floors.length} 地板, ${walls.length} 墙组, ` +
      `${carpets.length} 地毯, ${Object.keys(furniture).length} 家具 → ${OUT}`,
  );
}

main().catch((e) => {
  console.error('[predecode] 失败:', e);
  process.exit(1);
});
