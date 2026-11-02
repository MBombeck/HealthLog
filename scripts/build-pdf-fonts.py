#!/usr/bin/env python3
"""Build the fonts the doctor-report PDF embeds.

jsPDF draws one font per text run and has no glyph fallback, so every script
the report can carry has to live in one font file. No single upstream Noto
font covers what the report needs: Noto Sans has Latin, Greek and Cyrillic but
no arrows or comparison signs, Noto Sans KR has Hangul but no Latin
Extended-A (Polish). This script merges them:

  ReportSans-{Regular,Bold,Italic}.ttf
      Noto Sans (Latin, Latin Extended-A/B, Greek, Cyrillic, punctuation,
      super-/subscripts, currency) plus the arrows and mathematical operators
      of Noto Sans Math.
  ReportSansKR-{Regular,Bold}.ttf
      The matching ReportSans weight plus Hangul (syllables, jamo,
      compatibility jamo) and CJK punctuation from Noto Sans KR, instanced
      at weight 400 / 700. Loaded only for a report that contains Hangul.

All sources are SIL Open Font License 1.1; the licence texts sit beside the
output. The merged fonts carry their own family name, as the OFL asks of a
modified version. Layout tables (GSUB/GPOS/GDEF/MATH) are dropped: jsPDF
does no shaping, and precomposed Hangul syllables need none.

Requires fonttools (`pip install fonttools`). Usage:

  python3 scripts/build-pdf-fonts.py <download-dir> <output-dir>

where <download-dir> holds the unhinted upstream TTFs:
  NotoSans-Regular.ttf, NotoSans-Bold.ttf, NotoSans-Italic.ttf
    https://github.com/notofonts/notofonts.github.io/tree/main/fonts/NotoSans/unhinted/ttf
  NotoSansMath-Regular.ttf
    https://github.com/notofonts/notofonts.github.io/tree/main/fonts/NotoSansMath/unhinted/ttf
  NotoSansKR[wght].ttf
    https://github.com/google/fonts/tree/main/ofl/notosanskr
"""

import copy
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer


def ranges(*spans):
    out = set()
    for lo, hi in spans:
        out.update(range(lo, hi + 1))
    return out


BASE_CODEPOINTS = ranges(
    (0x0020, 0x007E),  # Basic Latin
    (0x00A0, 0x024F),  # Latin-1, Latin Extended-A/B
    (0x0250, 0x02FF),  # IPA, spacing modifiers
    (0x0300, 0x036F),  # combining diacritics
    (0x0370, 0x03FF),  # Greek
    (0x0400, 0x052F),  # Cyrillic + supplement
    (0x1E00, 0x1EFF),  # Latin Extended Additional
    (0x2000, 0x206F),  # general punctuation
    (0x2070, 0x209F),  # super-/subscripts
    (0x20A0, 0x20CF),  # currency
    (0x2100, 0x214F),  # letterlike (°C, №, ™)
    (0x2150, 0x218F),  # number forms
)
SYMBOL_CODEPOINTS = ranges(
    (0x2190, 0x21FF),  # arrows
    (0x2200, 0x22FF),  # mathematical operators (≈ ≤ ≥ ±)
)
HANGUL_CODEPOINTS = ranges(
    (0x1100, 0x11FF),  # Hangul jamo
    (0x3000, 0x303F),  # CJK symbols and punctuation
    (0x3130, 0x318F),  # compatibility jamo
    (0xA960, 0xA97F),  # jamo extended-A
    (0xAC00, 0xD7A3),  # syllables
    (0xD7B0, 0xD7FF),  # jamo extended-B
)
DROP_TABLES = ["GSUB", "GPOS", "GDEF", "MATH", "BASE", "JSTF", "DSIG", "STAT"]


def subset_font(font: TTFont, codepoints: set[int]) -> TTFont:
    options = subset.Options()
    options.layout_features = []
    options.drop_tables += DROP_TABLES
    options.hinting = False
    options.notdef_outline = True
    options.name_IDs = ["*"]
    options.glyph_names = True
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=codepoints & set(font.getBestCmap()))
    subsetter.subset(font)
    return font


def copy_glyph(base: TTFont, donor: TTFont, name: str, prefix: str) -> str:
    """Copy one donor glyph (and its components) into base; return its name."""
    new_name = f"{prefix}{name}"
    glyf = base["glyf"]
    if new_name in glyf.glyphs:
        return new_name
    glyph = copy.deepcopy(donor["glyf"][name])
    if glyph.isComposite():
        for component in glyph.components:
            component.glyphName = copy_glyph(
                base, donor, component.glyphName, prefix
            )
    glyf.glyphs[new_name] = glyph
    glyf.glyphOrder.append(new_name)
    base["hmtx"].metrics[new_name] = donor["hmtx"].metrics[name]
    order = base.getGlyphOrder()
    if new_name not in order:
        order.append(new_name)
        base.setGlyphOrder(order)
    return new_name


def merge(base: TTFont, donor: TTFont, prefix: str) -> None:
    if base["head"].unitsPerEm != donor["head"].unitsPerEm:
        raise SystemExit("unitsPerEm differs between base and donor")
    base_cmap = base.getBestCmap()
    additions = {}
    for cp, name in donor.getBestCmap().items():
        if cp in base_cmap:
            continue
        additions[cp] = copy_glyph(base, donor, name, prefix)
    for table in base["cmap"].tables:
        if table.isUnicode():
            if table.format == 4 and any(cp > 0xFFFF for cp in additions):
                continue
            table.cmap.update(additions)
    base["maxp"].numGlyphs = len(base.getGlyphOrder())
    base["hhea"].numberOfHMetrics = len(base.getGlyphOrder())
    base["hhea"].advanceWidthMax = max(
        base["hhea"].advanceWidthMax,
        max(width for width, _ in donor["hmtx"].metrics.values()),
    )


def finish(font: TTFont, family: str, style: str, path: Path) -> None:
    """Rename, drop glyph names, save.

    jsPDF copies the whole `post` table into every PDF it writes, subset or
    not, so glyph names would cost each report tens of kilobytes (hundreds
    with Hangul). Format 3 carries none.
    """
    font["post"].formatType = 3.0
    rename(font, family, style)
    font.save(path)


def rename(font: TTFont, family: str, style: str) -> None:
    name = font["name"]
    postscript = f"{family}-{style}"
    for record in list(name.names):
        if record.nameID in (1, 16):
            record.string = family
        elif record.nameID in (2, 17):
            record.string = style
        elif record.nameID == 3:
            record.string = f"{postscript};HealthLog"
        elif record.nameID == 4:
            record.string = f"{family} {style}"
        elif record.nameID == 6:
            record.string = postscript


def build(src: Path, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    math = subset_font(TTFont(src / "NotoSansMath-Regular.ttf"), SYMBOL_CODEPOINTS)
    kr_source = src / "NotoSansKR[wght].ttf"

    for style in ("Regular", "Bold", "Italic"):
        base = subset_font(TTFont(src / f"NotoSans-{style}.ttf"), BASE_CODEPOINTS)
        merge(base, math, "math.")
        finish(base, "ReportSans", style, out / f"ReportSans-{style}.ttf")

        if style == "Italic":
            continue
        weight = 400 if style == "Regular" else 700
        kr = subset_font(TTFont(kr_source), HANGUL_CODEPOINTS)
        kr = instancer.instantiateVariableFont(kr, {"wght": weight})
        with_hangul = TTFont(out / f"ReportSans-{style}.ttf")
        merge(with_hangul, kr, "kr.")
        finish(with_hangul, "ReportSansKR", style, out / f"ReportSansKR-{style}.ttf")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    build(Path(sys.argv[1]), Path(sys.argv[2]))
