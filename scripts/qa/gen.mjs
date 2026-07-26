import { readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
// 项目根目录：脚本从仓库根目录运行，使用进程工作目录，避免硬编码绝对路径
const ROOT = process.cwd();
const OUT = ROOT + "/scripts/qa/_fesrc";
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT + "/utils", { recursive: true });
mkdirSync(OUT + "/mock", { recursive: true });
mkdirSync(OUT + "/services", { recursive: true });

// 去掉对 ../types 的类型导入（运行时不需要），并把相对 import 补 .ts 扩展名
function prep(src) {
  let s = src.replace(/import\s*\{[^}]*\}\s*from\s*["']\.\.\/types["'];?/g, "");
  s = s.replace(/from\s*(["'])(\.\.?\/[^"']+?)\1/g, 'from "$2.ts"');
  return s;
}
function build(srcRel, outRel) {
  writeFileSync(OUT + "/" + outRel, prep(readFileSync(ROOT + "/" + srcRel, "utf8")));
}
build("src/utils/radar.ts", "utils/radar.ts");
build("src/mock/samples.ts", "mock/samples.ts");
build("src/services/mockEvaluator.ts", "services/mockEvaluator.ts");
console.log("generated stripped frontend sources ->", OUT);
