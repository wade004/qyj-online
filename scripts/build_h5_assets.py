"""Generate committed H5 variants from the canonical runtime artwork."""

from pathlib import Path
from PIL import Image, ImageOps


ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "assets" / "characters"
OUTPUT = ROOT / "assets" / "h5" / "heroes"
SIZES = ((320, 78), (640, 82))
CARD_SIZE = (192, 288)
CARD_QUALITY = 80
CARD_SOURCES = (
    ("02", ROOT / "assets" / "rankb_02_20260705150419.png"),
    ("03", ROOT / "assets" / "rankb_03_20260705150419.png"),
    ("04", ROOT / "assets" / "rankb_04_20260705150419.png"),
    ("05", ROOT / "assets" / "rankb_05_20260705150419.png"),
    ("06", ROOT / "assets" / "rankb_06_20260705150419.png"),
    ("07", ROOT / "assets" / "rankb_07_20260705150845.png"),
    ("08", ROOT / "assets" / "rankb_08_20260705150845.png"),
    ("09", ROOT / "assets" / "rankb_09_20260705150845.png"),
    ("10", ROOT / "assets" / "rankb_10_20260705150845.png"),
    ("J", ROOT / "assets" / "rankc_J_20260705154216.png"),
    ("Q", ROOT / "assets" / "rankc_Q_20260705154216.png"),
    ("K", ROOT / "assets" / "rankc_K_20260705154216.png"),
    ("A", ROOT / "assets" / "rankc_A_20260705154216.png"),
)


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    sources = sorted(path for path in SOURCE.iterdir() if path.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"})
    sources = [path for path in sources if not path.name.startswith("ref_")]
    generated = 0
    for source in sources:
        with Image.open(source) as image:
            image = image.convert("RGB")
            for size, quality in SIZES:
                variant = ImageOps.fit(
                    image,
                    (size, size),
                    method=Image.Resampling.LANCZOS,
                    centering=(0.5, 0.28),
                )
                destination = OUTPUT / f"{source.stem}_{size}.webp"
                variant.save(destination, "WEBP", quality=quality, method=6)
                generated += 1
    background_output = ROOT / "assets" / "h5" / "backgrounds"
    background_output.mkdir(parents=True, exist_ok=True)
    with Image.open(ROOT / "assets" / "bg" / "gaming_bg.jpg") as image:
        background = ImageOps.fit(
            image.convert("RGB"),
            (1280, 720),
            method=Image.Resampling.LANCZOS,
            centering=(0.5, 0.5),
        )
        background.save(background_output / "gaming_bg_1280.webp", "WEBP", quality=76, method=6)
        generated += 1

    card_output = ROOT / "assets" / "h5" / "cards"
    card_output.mkdir(parents=True, exist_ok=True)
    card_sources = (("cardback", ROOT / "assets" / "theme" / "cardback.png"), *CARD_SOURCES)
    for name, source in card_sources:
        with Image.open(source) as image:
            card = ImageOps.fit(
                image.convert("RGB"),
                CARD_SIZE,
                method=Image.Resampling.LANCZOS,
                centering=(0.5, 0.5),
            )
            destination = card_output / ("cardback.webp" if name == "cardback" else f"rank_{name}.webp")
            card.save(destination, "WEBP", quality=CARD_QUALITY, method=6)
            generated += 1

    total = sum(path.stat().st_size for path in (ROOT / "assets" / "h5").rglob("*.webp"))
    print(f"Generated {generated} H5 asset variants ({total / 1024 / 1024:.2f} MiB).")


if __name__ == "__main__":
    main()
