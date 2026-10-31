# Draws public/logo.svg (the "Power wheel" logo, 32 x 32 pixel art): python tools/make_logo.py public/logo.svg
import math, sys

N = 32
px = [[None] * N for _ in range(N)]
OUT, GREY_D, GREY, GREY_L, HUB = "#1d1a14", "#4b5563", "#9ca3af", "#e5e7eb", "#6b7280"
ORANGE, ORANGE_D, CREAM, PINK, YEL, YEL_D = "#f5a623", "#c2410c", "#ffe8c2", "#f472b6", "#ffd166", "#f5a623"

def put(x, y, c):
    if 0 <= x < N and 0 <= y < N: px[y][x] = c

def line(x0, y0, x1, y1, c, w=1):
    n = int(max(abs(x1 - x0), abs(y1 - y0)) * 2) + 1
    for k in range(n + 1):
        t = k / n
        x, y = x0 + (x1 - x0) * t, y0 + (y1 - y0) * t
        for dx in range(w):
            put(int(round(x)) + dx, int(round(y)), c)

cx, cy = 14.5, 14.5
# stand: two legs and a foot bar, behind the wheel
line(14, 15, 7, 29, GREY_D, 2); line(15, 15, 21, 29, GREY_D, 2)
for x in range(4, 26): put(x, 30, OUT); put(x, 29, GREY_D if x in (4, 25) else HUB)
# wheel: outline, rim, inner edge; spokes and hub inside
for y in range(N):
    for x in range(N):
        d = math.hypot(x + 0.5 - cx, y + 0.5 - cy)
        if 12.6 < d <= 13.6: px[y][x] = OUT
        elif 10.4 < d <= 12.6: px[y][x] = GREY_L if (x + y) < 29 else GREY
        elif 9.6 < d <= 10.4: px[y][x] = HUB
for a in range(0, 360, 90):
    r = math.radians(a + 45)
    line(cx - 0.5, cy - 0.5, cx - 0.5 + math.cos(r) * 9.6, cy - 0.5 + math.sin(r) * 9.6, GREY)
put(14, 14, HUB)

# the hamster, mid-run on the bottom of the rim, facing right: a hand-drawn 15 x 10 sprite
HAM = [
    "..........11...",
    "....11111.1p1..",
    "..113333311331.",
    ".14443333333331",
    ".14333333331331",
    "143333333333333p"[:15],
    "1333cccc3333331",
    ".13cccccc333331",
    "..11ccccc1111..",
    "...1.1..1.1....",
]
COL = {"1": OUT, "3": ORANGE, "4": ORANGE_D, "c": CREAM, "p": PINK}
for r, row in enumerate(HAM):
    for k, ch in enumerate(row):
        if ch in COL: put(6 + k, 15 + r, COL[ch])

# the lightning bolt, top right, over everything
bolt = [(26.5, 0), (20.5, 10.5), (24.5, 10.5), (21.5, 19.5), (30.5, 7.5), (26.8, 7.5), (30.5, 0)]
def inside(x, y, poly):
    c = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]; xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi: c = not c
        j = i
    return c
fill = {(x, y) for y in range(N) for x in range(N) if inside(x + 0.5, y + 0.5, bolt)}
for (x, y) in fill:
    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (-1, -1), (1, -1), (-1, 1)):
        if (x + dx, y + dy) not in fill: put(x + dx, y + dy, OUT)
for (x, y) in fill: put(x, y, YEL)
for (x, y) in fill:  # a darker right edge for depth
    if (x + 1, y) not in fill: put(x, y, YEL_D)

# SVG, one rect per horizontal run
rects = []
for y in range(N):
    x = 0
    while x < N:
        c = px[y][x]
        if c is None: x += 1; continue
        x1 = x
        while x1 + 1 < N and px[y][x1 + 1] == c: x1 += 1
        rects.append(f'<rect x="{x}" y="{y}" width="{x1 - x + 1}" height="1" fill="{c}"/>')
        x = x1 + 1
svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32" shape-rendering="crispEdges">'
       '<title>Squeek Den</title>' + "".join(rects) + "</svg>\n")
open(sys.argv[1], "w", encoding="utf8", newline="\n").write(svg)
print(len(rects), "rects")
for row in px: print("".join("." if c is None else {OUT: "1", GREY_D: "e", GREY: "d", GREY_L: "2", HUB: "h", ORANGE: "3", ORANGE_D: "4", CREAM: "c", PINK: "p", YEL: "6"}.get(c, "?") for c in row))
