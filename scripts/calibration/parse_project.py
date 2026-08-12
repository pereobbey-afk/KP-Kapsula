"""
Разбор ведомостей дизайн-проекта «Капсулы».

Проект — векторный PDF из ArchiCAD с текстовым слоем в CP1251.
Таблицы восстанавливаются группировкой слов по координате Y: строка
таблицы — это все слова с близким Y, отсортированные по X.

Извлекаются исходные величины, которые сметчик переносит в смету:
  - экспликация помещений: площадь каждого помещения и итог;
  - ведомость напольного покрытия: площади покрытий и длина плинтуса;
  - ведомость тёплого пола: площадь обогрева;
  - ведомость отделки стен: площади по каждому виду настенной отделки;
  - ведомость электроблоков: количество блоков и механизмов.

Скрипт калибровочный: он проверяет, что методика из docs/methodology.md
воспроизводится на реальном проекте. В продукте те же величины извлекает
модель, а правила вывода считает детерминированный код.

Вывод — JSON в stdout при ключе --json, иначе человекочитаемая сводка.
"""

from __future__ import annotations

import json
import re
import sys
from dataclasses import asdict, dataclass, field

import pymupdf


def decode(text: str) -> str:
    """Текст в PDF записан в CP1251, а читается как Latin-1."""
    return text.encode("latin-1", "ignore").decode("cp1251", "ignore")


def rows_by_y(page: pymupdf.Page, tolerance: int = 4) -> list[tuple[int, str]]:
    """Собирает строки таблицы: слова с близким Y, упорядоченные по X."""
    buckets: dict[int, list[tuple[float, str]]] = {}
    for word in page.get_text("words"):
        x, y, text = word[0], word[1], decode(word[4])
        buckets.setdefault(round(y / tolerance), []).append((x, text))
    return [
        (key * tolerance, " ".join(t for _, t in sorted(words)))
        for key, words in sorted(buckets.items())
    ]


def sheet_title(page: pymupdf.Page) -> str:
    """Название листа берётся из штампа — строки со ссылкой на сайт."""
    for _, line in rows_by_y(page):
        if "Сайт:" in line:
            return line.split("Сайт:")[0].strip()
    return ""


@dataclass
class Room:
    number: str
    name: str
    area: float


@dataclass
class FloorFinish:
    position: str
    kind: str
    material: str
    area: float


@dataclass
class HeatedFloor:
    room: str
    position: str
    area: float


@dataclass
class RoughMaterial:
    name: str
    volume_m3: float
    area_m2: float


@dataclass
class WallFinish:
    room: str
    position: str
    description: str
    area: float


@dataclass
class ElectricBlock:
    room: str
    position: str
    modules: int


@dataclass
class Project:
    rooms: list[Room] = field(default_factory=list)
    floor_finishes: list[FloorFinish] = field(default_factory=list)
    skirting_mm: float | None = None
    heated_floor: list[HeatedFloor] = field(default_factory=list)
    rough_materials: list[RoughMaterial] = field(default_factory=list)
    wall_finishes: list[WallFinish] = field(default_factory=list)
    electric_blocks: list[ElectricBlock] = field(default_factory=list)

    @property
    def total_area(self) -> float:
        return round(sum(r.area for r in self.rooms), 2)


# Название помещения может содержать цифру и дефис: «Санузел-2».
ROOM_ROW = re.compile(r"^(\d{2})\s+([А-ЯЁ][А-Яа-яЁё][А-Яа-яЁё\-\d ]*?)\s+(\d+,\d+)\s*$")
FLOOR_ROW = re.compile(r"^(\d{2})\s+(Кварцвинил|Напольная плитка)\s+(.+?)\s+(\d+,\d+)\b")
HEATED_ROW = re.compile(r"^(\d+)\s+Электрический\s+тепл[а-яё]*\s+пол.*?(\d+,\d+)\s*$")
FINISH_ROW = re.compile(r"^(\d{2}\.\d{2})\s+(.+?)\s+(\d+,\d+)")
SKIRTING_ROW = re.compile(r"Плинтус\s+напольный\s+([\d\s]+?)\s+[A-ZА-Я]")
ROUGH_ROW = re.compile(r"^([А-ЯЁ][А-Яа-яЁё\- ]+?)\s+(\d+,\d+)\s+(\d+,\d+)\s*$")
BLOCK_FRAME = re.compile(r"Рамка\s*х\s*(\d+)")
POSITION_CODE = re.compile(r"\b(\d{2}\.\d{2})\b")
ROOM_HEADER = re.compile(r"^Помещение:\s*([А-Яа-яЁё\-\d ]+?)(?:\s{2,}|$)")


def parse_number(text: str) -> float:
    return float(text.replace(",", "."))


def room_header(line: str) -> str | None:
    """
    Заголовок помещения в ведомости.

    В строке заголовка может оказаться посторонний текст с той же
    координатой Y (например, «Колличество: 31 шт» из соседней колонки),
    поэтому берём только первое слово-название.
    """
    if not line.startswith("Помещение"):
        return None
    rest = line.split(":", 1)[1] if ":" in line else line.replace("Помещение", "", 1)
    match = re.match(r"\s*([А-ЯЁ][А-Яа-яЁё\-]*(?:\s+\d)?)", rest)
    return match.group(1).strip() if match else ""


def parse_explication(page: pymupdf.Page) -> list[Room]:
    """Экспликация помещений: номер, наименование, площадь."""
    rooms: list[Room] = []
    for _, line in rows_by_y(page):
        match = ROOM_ROW.match(line.strip())
        if match:
            rooms.append(
                Room(match.group(1), match.group(2).strip(), parse_number(match.group(3)))
            )
    return rooms


def parse_floor(page: pymupdf.Page) -> tuple[list[FloorFinish], float | None]:
    """
    Ведомость напольного покрытия и ведомость плинтусов.

    Обе таблицы на одном листе и их строки пересекаются по координате Y,
    поэтому разбираются одним проходом.
    """
    finishes: list[FloorFinish] = []
    skirting: float | None = None

    for _, line in rows_by_y(page):
        stripped = line.strip()

        skirt = SKIRTING_ROW.search(stripped)
        if skirt and skirting is None:
            skirting = float(skirt.group(1).replace(" ", ""))

        # Строка ведомости полов может начинаться не с начала строки:
        # слева на том же Y стоит текст соседней таблицы.
        for candidate in (stripped, *re.split(r"(?=\b\d{2}\s+(?:Кварцвинил|Напольная))", stripped)):
            match = FLOOR_ROW.match(candidate.strip())
            if match:
                finishes.append(
                    FloorFinish(
                        position=match.group(1),
                        kind=match.group(2),
                        material=re.sub(r"\s+", " ", match.group(3)).strip(),
                        area=parse_number(match.group(4)),
                    )
                )
                break

    return finishes, skirting


def parse_heated_floor(page: pymupdf.Page) -> list[HeatedFloor]:
    """Ведомость тёплого пола: площадь обогреваемых зон по помещениям."""
    zones: list[HeatedFloor] = []
    current_room = ""
    for _, line in rows_by_y(page):
        stripped = line.strip()
        header = room_header(stripped)
        if header is not None:
            current_room = header
            continue
        match = HEATED_ROW.match(stripped)
        if match:
            zones.append(HeatedFloor(current_room, match.group(1), parse_number(match.group(2))))
    return zones


def parse_rough_materials(page: pymupdf.Page) -> list[RoughMaterial]:
    """
    Ведомость черновой отделки на плане монтажа перегородок.

    Строка: наименование, объём в м³, площадь в м². Отсюда берётся площадь
    шумоизоляции стен — величина, которой нет ни в экспликации, ни в
    ведомости отделки.
    """
    materials: list[RoughMaterial] = []
    for _, line in rows_by_y(page):
        match = ROUGH_ROW.match(line.strip())
        if match:
            materials.append(
                RoughMaterial(
                    name=match.group(1).strip(),
                    volume_m3=parse_number(match.group(2)),
                    area_m2=parse_number(match.group(3)),
                )
            )
    return materials


def parse_wall_finishes(page: pymupdf.Page) -> list[WallFinish]:
    """
    Ведомость отделки стен.

    Строка таблицы начинается с кода позиции вида «05.02». Площадь —
    первое число с запятой после кода: следом идут артикулы и цены,
    в которых запятой нет.
    """
    finishes: list[WallFinish] = []
    current_room = ""

    for _, line in rows_by_y(page):
        stripped = line.strip()

        header = room_header(stripped)
        if header is not None:
            current_room = header
            continue

        match = FINISH_ROW.match(stripped)
        if not match:
            continue

        description = re.sub(r"\s+", " ", match.group(2)).strip()
        finishes.append(
            WallFinish(
                room=current_room,
                position=match.group(1),
                description=description,
                area=parse_number(match.group(3)),
            )
        )
    return finishes


def parse_electric_blocks(page: pymupdf.Page) -> list[ElectricBlock]:
    """
    Ведомость электроблоков.

    Один блок занимает несколько строк: «Рамка х3» и код позиции «06.05»
    стоят на разных координатах Y. Поэтому блок опознаётся по упоминанию
    рамки, а код позиции ищется в ближайших строках ниже.

    «Рамка х3» означает три механизма и, соответственно, три подрозетника.
    """
    blocks: list[ElectricBlock] = []
    lines = [line.strip() for _, line in rows_by_y(page)]
    current_room = ""

    for index, line in enumerate(lines):
        header = room_header(line)
        if header is not None:
            current_room = header
            continue

        frame = BLOCK_FRAME.search(line)
        if not frame:
            continue

        position = ""
        for nearby in lines[index : index + 4]:
            code = POSITION_CODE.search(nearby)
            if code:
                position = code.group(1)
                break

        blocks.append(ElectricBlock(current_room, position, int(frame.group(1))))

    return blocks


def load_project(path: str) -> Project:
    doc = pymupdf.open(path)
    project = Project()

    for index in range(doc.page_count):
        page = doc[index]
        title = sheet_title(page)
        text = decode(page.get_text())

        # Лист опознаётся по содержимому, а не по номеру: порядок листов
        # в разных проектах отличается. Лист «Содержание» перечисляет те же
        # заголовки, поэтому дополнительно требуем наличие самой таблицы.
        if "Экспликация помещений" in title and not project.rooms:
            project.rooms = parse_explication(page)

        if "Ведомость напольного покрытия" in text and not project.floor_finishes:
            finishes, skirting = parse_floor(page)
            project.floor_finishes = finishes
            project.skirting_mm = skirting

        if "Ведомость теплого пола" in text and not project.heated_floor:
            project.heated_floor = parse_heated_floor(page)

        if "Ведомость черновой отделки" in text and not project.rough_materials:
            project.rough_materials = parse_rough_materials(page)

        if "Ведомость отделки стен" in title and not project.wall_finishes:
            project.wall_finishes = parse_wall_finishes(page)

        if "Ведомость электроблоков" in text:
            project.electric_blocks.extend(parse_electric_blocks(page))

    return project


# Классификация видов отделки по описанию из ведомости.
WALL_KINDS: list[tuple[str, re.Pattern[str]]] = [
    ("покраска_обои", re.compile(r"обои под покраску", re.I)),
    ("плитка_стены", re.compile(r"керамогранит|плитка", re.I)),
    ("панели", re.compile(r"панель", re.I)),
]


def classify_wall(description: str) -> str:
    for kind, pattern in WALL_KINDS:
        if pattern.search(description):
            return kind
    return "прочее"


def wall_totals(project: Project) -> dict[str, float]:
    totals: dict[str, float] = {}
    for finish in project.wall_finishes:
        kind = classify_wall(finish.description)
        totals[kind] = round(totals.get(kind, 0.0) + finish.area, 2)
    return totals


def floor_totals(project: Project) -> dict[str, float]:
    totals: dict[str, float] = {}
    for finish in project.floor_finishes:
        key = "плитка_пол" if finish.kind == "Напольная плитка" else "ламинат"
        totals[key] = round(totals.get(key, 0.0) + finish.area, 2)
    return totals


def to_json(project: Project) -> dict[str, object]:
    """Исходные величины проекта — вход детерминированного расчёта."""
    return {
        "rooms": [asdict(r) for r in project.rooms],
        "totalAreaM2": project.total_area,
        "floorFinishes": [asdict(f) for f in project.floor_finishes],
        "floorTotals": floor_totals(project),
        "skirtingM": round(project.skirting_mm / 1000, 3) if project.skirting_mm else None,
        "heatedFloorM2": round(sum(z.area for z in project.heated_floor), 2),
        "heatedFloorZones": [asdict(z) for z in project.heated_floor],
        "roughMaterials": [asdict(m) for m in project.rough_materials],
        "wallFinishes": [asdict(w) for w in project.wall_finishes],
        "wallTotals": wall_totals(project),
        "electricBlocks": len(project.electric_blocks),
        "electricModules": sum(b.modules for b in project.electric_blocks),
    }


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    path = args[0] if args else "проект_1191.pdf"
    project = load_project(path)

    if "--json" in sys.argv:
        json.dump(to_json(project), sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
        return

    print(f"ПОМЕЩЕНИЙ: {len(project.rooms)}")
    for room in project.rooms:
        print(f"  {room.number}  {room.name:<16} {room.area:>7.2f} м²")
    print(f"  {'ИТОГО':<20} {project.total_area:>7.2f} м²")

    print("\nПОЛЫ:")
    for finish in project.floor_finishes:
        print(f"  {finish.position}  {finish.kind:<18} {finish.area:>7.2f} м²")
    for kind, area in floor_totals(project).items():
        print(f"  ИТОГО {kind:<16} {area:>7.2f} м²")
    if project.skirting_mm:
        print(f"  Плинтус {project.skirting_mm / 1000:>21.3f} м.п.")

    print(f"\nТЁПЛЫЙ ПОЛ: {sum(z.area for z in project.heated_floor):.2f} м²")
    for zone in project.heated_floor:
        print(f"  {zone.room:<14} зона {zone.position}  {zone.area:>6.2f} м²")

    if project.rough_materials:
        print("\nЧЕРНОВАЯ ОТДЕЛКА:")
        for material in project.rough_materials:
            print(f"  {material.name:<26} {material.volume_m3:>6.2f} м³  {material.area_m2:>7.2f} м²")

    print(f"\nОТДЕЛКА СТЕН, ПОЗИЦИЙ: {len(project.wall_finishes)}")
    for kind, area in sorted(wall_totals(project).items(), key=lambda kv: -kv[1]):
        print(f"  {kind:<16} {area:>7.2f} м²")

    print(
        f"\nЭЛЕКТРОБЛОКИ: {len(project.electric_blocks)} блоков, "
        f"{sum(b.modules for b in project.electric_blocks)} механизмов"
    )


if __name__ == "__main__":
    main()
