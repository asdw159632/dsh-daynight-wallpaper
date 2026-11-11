#!/usr/bin/env bash
# ============================================================================
# 昼夜壁纸 · 素材构建（多场景）
#
# 把「日转夜延时」动图按「真实时刻锚点表」抽帧、放大、编码成 WebP，并生成：
#
#   assets/scenes.json                 场景清单（id / 名称 / 各自的时刻表路径）
#   assets/<id>/schedule.json          该场景的时刻表（at / src / dim / label / labelEn）
#   assets/<id>/frames/NNN.webp        该场景的定帧
#
# 为什么不是直接放整张动图：源动图几秒走完一整个昼夜，播起来是「4 秒看完一天」。
# 壁纸要的是「窗口里的天色 = 现在的天色」，所以先把一天映射到十几个关键时刻，
# 再由前端按当前时钟在相邻两张之间做连续叠化。
#
# 用法：
#   ./build-frames.sh                 # 构建全部场景
#   ./build-frames.sh tokyo           # 只构建一个场景
#
# 场景定义：tools/scenes.conf（一行一个场景）+ tools/scenes/<id>.anchors（时刻锚点）
#
# 依赖：ffmpeg（抽帧）、ImageMagick convert/identify（测量亮度、放大、编码）
# ============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"          # mods/background
OUT="$ROOT/daynight-peak/assets"
CONF="$HERE/scenes.conf"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ---- 读场景表 -------------------------------------------------------------
declare -a ORDER=()
declare -A SRC NAME NAME_EN WIDTH QUALITY
while read -r id src name name_en width quality; do
  [ -n "${id:-}" ] || continue
  case "$id" in \#*) continue ;; esac
  ORDER+=("$id")
  SRC["$id"]="$src"
  NAME["$id"]="$name"
  NAME_EN["$id"]="$name_en"
  WIDTH["$id"]="$width"
  QUALITY["$id"]="$quality"
done < "$CONF"

TARGETS=("$@")
[ "${#TARGETS[@]}" -gt 0 ] || TARGETS=("${ORDER[@]}")

mkdir -p "$OUT"

# ---- 亮度 → 遮罩浓度 ------------------------------------------------------
# 壁纸要被半透明面板压着用，所以「纱」随画面亮度走，但阈值按**每个场景自己的**
# 亮度范围归一化（山景 0.19–0.43，东京 0.12–0.57）：最深夜 ≈0.02，最亮昼 ≈0.32。
# 为什么不再重一点：插件还会把外壳底板（--dsw-alias-bg-base）压到 ≤0.35 才让壁纸
# 透出来，那层已经是"纱"了；两层叠加再重就会把白天压成黄昏。
dim_of_lum() {
  awk -v lum="$1" -v lo="$2" -v hi="$3" 'BEGIN{
    dlo=0.02; dhi=0.32;
    if (hi <= lo) { printf "%.2f", dlo; exit }
    d = dlo + (lum - lo) / (hi - lo) * (dhi - dlo);
    if (d < 0.02) d = 0.02;
    if (d > 0.34) d = 0.34;
    printf "%.2f", d;
  }'
}

for ID in "${TARGETS[@]}"; do
  SRC_FILE="$ROOT/${SRC[$ID]:-}"
  ANCHORS="$HERE/scenes/$ID.anchors"
  [ -f "$SRC_FILE" ] || { echo "场景 $ID：源动图不存在：$SRC_FILE" >&2; exit 1; }
  [ -f "$ANCHORS" ] || { echo "场景 $ID：锚点表不存在：$ANCHORS" >&2; exit 1; }

  echo "→ [$ID] 抽帧：$SRC_FILE"
  rm -rf "${TMP:?}/$ID"
  mkdir -p "$TMP/$ID"
  ffmpeg -v error -i "$SRC_FILE" "$TMP/$ID/f%03d.png" -y
  TOTAL=$(find "$TMP/$ID" -name 'f*.png' | wc -l)
  echo "  共 $TOTAL 帧"

  # ---- 第一遍：量每个锚点帧的亮度，求场景的亮度范围 ----
  MINUTES=(); IDXS=(); ZHS=(); ENS=(); LUMS=()
  MIN_LUM=9
  MAX_LUM=-1
  while read -r minute idx zh en; do
    [ -n "${minute:-}" ] || continue
    case "$minute" in \#*) continue ;; esac
    pad=$(printf "%03d" "$idx")
    [ -f "$TMP/$ID/f$pad.png" ] || { echo "  场景 $ID 缺帧 f$pad.png" >&2; exit 1; }
    lum=$(identify -format '%[fx:mean]' "$TMP/$ID/f$pad.png")
    MINUTES+=("$minute"); IDXS+=("$pad"); ZHS+=("$zh"); ENS+=("$en"); LUMS+=("$lum")
    MIN_LUM=$(awk -v a="$MIN_LUM" -v b="$lum" 'BEGIN{print (b<a)?b:a}')
    MAX_LUM=$(awk -v a="$MAX_LUM" -v b="$lum" 'BEGIN{print (b>a)?b:a}')
  done < "$ANCHORS"

  # ---- 第二遍：编码 + 拼时刻表 ----
  rm -rf "${OUT:?}/$ID"
  mkdir -p "$OUT/$ID/frames"
  POINTS=""
  SEEN=""
  for i in "${!MINUTES[@]}"; do
    minute="${MINUTES[$i]}"
    pad="${IDXS[$i]}"
    dim=$(dim_of_lum "${LUMS[$i]}" "$MIN_LUM" "$MAX_LUM")
    case " $SEEN " in
      *" $pad "*) ;;
      *)
        convert "$TMP/$ID/f$pad.png" \
          -filter Mitchell -resize "${WIDTH[$ID]}x" \
          -unsharp 0x0.8+0.5+0.01 \
          -quality "${QUALITY[$ID]}" -define webp:method=6 \
          "$OUT/$ID/frames/$pad.webp"
        SEEN="$SEEN $pad"
        echo "  帧 $pad → $ID/frames/$pad.webp  (亮度 $(printf '%.4f' "${LUMS[$i]}")  纱 $dim)"
        ;;
    esac
    [ -z "$POINTS" ] || POINTS="$POINTS,"
    POINTS="$POINTS
    { \"at\": $minute, \"src\": \"frames/$pad.webp\", \"dim\": $dim, \"label\": \"${ZHS[$i]}\", \"labelEn\": \"${ENS[$i]}\" }"
  done

  height=$(identify -format '%h' "$OUT/$ID/frames/${IDXS[0]}.webp")
  cat > "$OUT/$ID/schedule.json" <<JSON
{
  "schema": "daynight-peak/schedule/1",
  "id": "$ID",
  "scene": "${NAME_EN[$ID]}",
  "width": ${WIDTH[$ID]},
  "height": $height,
  "source": { "file": "${SRC[$ID]}", "frames": $TOTAL, "anchors": "tools/scenes/$ID.anchors" },
  "note": "at = 本地时刻的分钟数；相邻两个 at 之间由前端按当前时钟连续叠化，最后一点之后回绕到第一点。dim = 该帧的遮罩浓度（0–1），随画面亮度反相关。",
  "points": [$POINTS
  ]
}
JSON
  echo "  亮暗范围 $(printf '%.3f–%.3f' "$MIN_LUM" "$MAX_LUM")，输出 $(du -sh "$OUT/$ID/frames" | cut -f1)"
done

# ---- 场景清单（只列磁盘上真的存在时刻表的场景）----------------------------
SCENES_JSON=""
for ID in "${ORDER[@]}"; do
  [ -f "$OUT/$ID/schedule.json" ] || continue
  [ -z "$SCENES_JSON" ] || SCENES_JSON="$SCENES_JSON,"
  SCENES_JSON="$SCENES_JSON
    { \"id\": \"$ID\", \"name\": \"${NAME[$ID]}\", \"nameEn\": \"${NAME_EN[$ID]}\", \"schedule\": \"$ID/schedule.json\" }"
done

cat > "$OUT/scenes.json" <<JSON
{
  "schema": "daynight-peak/scenes/1",
  "note": "场景清单；浏览器半区先读它，再按设置里的 scene 取该场景的时刻表。",
  "scenes": [$SCENES_JSON
  ]
}
JSON

echo "→ 完成：$OUT"
echo "  场景：$(grep -o '"id": "[a-z0-9-]*"' "$OUT/scenes.json" | cut -d'"' -f4 | tr '\n' ' ')"
