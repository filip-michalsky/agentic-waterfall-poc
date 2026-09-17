#!/usr/bin/env python3
"""Render one 36-second story: API animations → recorded browser → result.

Local files only. Requires Pillow, ffmpeg/ffprobe and the clean vid-stripe2 take.
The illustrated API decline and the recorded Stripe success are separate takes.
"""
from __future__ import annotations
import argparse
import functools
import hashlib
import json
import math
from pathlib import Path
import shutil
import subprocess
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out/reel"
WORK = OUT / "work/unified"
SOURCE = ROOT / "out/vid-stripe2/video/stripe.mp4"
FPS = 30
SIZES = {"16x9": (1920, 1080), "1x1": (1080, 1080), "9x16": (1080, 1920)}
BG, PANEL, LINE = "#09131B", "#102430", "#345263"
WHITE, MUTED, CYAN, GREEN, AMBER = "#F0F5F4", "#9FB6C5", "#74DEEB", "#C8EC9A", "#FFC58B"
FONT = "/System/Library/Fonts/Avenir Next.ttc"
MONO = "/System/Library/Fonts/Menlo.ttc"
SCENES = [("intro", 3), ("api", 8), ("adyen", 6), ("handoff", 2), ("browser", 12), ("result", 5)]
TOTAL = sum(duration for _, duration in SCENES)

@functools.lru_cache(maxsize=64)
def font(size, mono=False):
    return ImageFont.truetype(MONO if mono else FONT, round(size), index=0)

def text(d, xy, value, size=30, color=WHITE, mono=False, anchor=None):
    d.text(xy, value, font=font(size, mono), fill=color, anchor=anchor)

def box(d, bounds, fill=PANEL, outline=LINE, radius=20):
    d.rounded_rectangle(tuple(round(v) for v in bounds), radius, fill, outline, width=2)

def packet(d, points, t, color=CYAN, active=True):
    d.line(points, fill=color if active else LINE, width=3, joint="curve")
    if not active:
        return
    lengths = [math.dist(a, b) for a, b in zip(points, points[1:])]
    travel = (t / 1.4 % 1) * sum(lengths)
    for (a, b), distance in zip(zip(points, points[1:]), lengths):
        if travel <= distance:
            x, y = (a[i] + (b[i] - a[i]) * travel / max(distance, 1) for i in (0, 1))
            d.ellipse((x-12, y-12, x+12, y+12), fill=LINE)
            d.ellipse((x-6, y-6, x+6, y+6), fill=color)
            break
        travel -= distance

def centered(d, y, value, width, size=30, color=WHITE, mono=False):
    # Captions fit each export independently; none are cropped from another aspect.
    while d.textlength(value, font=font(size, mono)) > width - 110:
        size -= 1
    text(d, (width/2, y), value, size, color, mono, "ma")

def graphic(t, mode="api"):
    im = Image.new("RGBA", (1000, 510))
    d = ImageDraw.Draw(im)
    phase = "request" if t < 2.2 else "proxy" if t < 4.4 else "response"
    if mode == "intro":
        labels = [("01", "Checkout.com", "API · simulated decline"), ("02", "Adyen API", "Test-triggered refusal"), ("03", "Stripe browser", "Fill, submit, confirm")]
    elif mode == "adyen":
        phase = "request" if t < 2.7 else "response"
        labels = [("{ }", "Orchestrator", "Same $19.99 purchase"), ("⇄", "HTTPS request", "Adyen test-card fixture"), ("↗", "Adyen", "Test API · no browser")]
    else:
        labels = [("{ }", "Orchestrator", "Card token + purchase"), ("⇄", "Basis Theory", "Proxy forwards card data"), ("↗", "Checkout.com", "Authorization API")]
    for i, (icon, title, detail) in enumerate(labels):
        x = 8 + i*350
        active = mode == "intro" or i == {"request": 0, "proxy": 1, "response": 2}[phase]
        color = AMBER if mode != "intro" and phase == "response" else CYAN
        box(d, (x, 88, x+282, 302), outline=color if active else LINE)
        text(d, (x+141, 112), icon, 43, color, True, "ma")
        text(d, (x+141, 185), title, 27, anchor="ma")
        text(d, (x+141, 238), detail, 16, MUTED, anchor="ma")
        if i < 2:
            packet(d, [(x+282, 193), (x+350, 193)], t, active=mode == "intro" or (i == 0 and phase == "request") or (i == 1 and (phase == "proxy" or mode == "adyen" and phase == "request")))
    if mode == "intro":
        centered(d, 378, "Two API routes. Then the browser.", 1000, 29, MUTED)
    elif phase == "response":
        packet(d, [(850, 302), (850, 350), (150, 350), (150, 302)], t, AMBER)
        box(d, (85, 391, 915, 477), fill="#30271E", outline=AMBER)
        centered(d, 415, "issuer_unavailable → continue", 1000, 29, AMBER, True)
    else:
        box(d, (85, 391, 915, 477))
        centered(d, 415, "POST /v71/payments · $19.99 USD" if mode == "adyen" else "POST /payments · $19.99 USD", 1000, 29, CYAN, True)
    return im

@functools.lru_cache(maxsize=360)
def footage(n):
    with Image.open(WORK / "stripe-cvv-frames" / f"{max(1, min(360, n)):04d}.jpg") as im:
        return im.convert("RGB")

def render(aspect, scene, t):
    w, h = SIZES[aspect]
    vertical = aspect == "9x16"
    im = Image.new("RGB", (w, h), BG)
    d = ImageDraw.Draw(im)
    margin = 72
    header = 115 if vertical else 42
    rail_y = 232 if vertical else 127
    title_y = 373 if vertical else 235
    graph_y = 656 if vertical else 387
    graph_h = 775 if vertical else 452
    footer_y = 1700 if vertical else 1004
    caption_y = 1530 if vertical else 917
    title_size = 72 if vertical else 66 if aspect == "16x9" else 56
    text(d, (margin, header+8), "Agentic Gateway", 40)
    text(d, (w-margin, header+22), "TEST CARDS · NO REAL MONEY", 17, AMBER, True, "ra")
    step = {"intro": 0, "api": 0, "adyen": 1, "handoff": 2, "browser": 2, "result": 3}[scene]
    col = (w - margin*2)/4
    for i, (label, detail) in enumerate([("01  CHECKOUT.COM", "API"), ("02  ADYEN", "API"), ("03  STRIPE", "BROWSER"), ("04  RESULT", "CONFIRMED")]):
        x = margin+i*col
        box(d, (x, rail_y, x+col, rail_y+67), fill="#1C3945" if i == step else PANEL, radius=0)
        text(d, (x+col/2, rail_y+12), label, 18, CYAN if i == step else MUTED, True, "ma")
        text(d, (x+col/2, rail_y+39), detail, 13, CYAN if i == step else MUTED, True, "ma")
    titles = {"intro": "One payment. One flow.", "adyen": "Next, Adyen via API.", "api": "Through the checkout API.", "handoff": "Now the browser takes over.", "browser": "The browser fills Stripe.", "result": "Payment confirmed."}
    centered(d, title_y, titles[scene], w, title_size)
    badge = {"intro": "CHECKOUT.COM → ADYEN → STRIPE", "api": "CHECKOUT.COM · SIMULATED DECLINE", "adyen": "ADYEN TEST API · ILLUSTRATED", "handoff": "ADYEN API → STRIPE BROWSER", "browser": "BROWSERBASE RECORDING · 2.9× SPEED", "result": "STRIPE SANDBOX · PAYMENT SUCCEEDED"}[scene]
    centered(d, title_y+title_size+29, badge, w, 21, AMBER if scene in ("api", "adyen") else GREEN if scene == "result" else CYAN, True)
    if scene in ("intro", "api", "adyen"):
        g = graphic(t, scene)
        scale = min((w-margin*2)/1000, graph_h/510)
        g = g.resize((round(1000*scale), round(510*scale)), Image.Resampling.LANCZOS)
        im.paste(g, (round((w-g.width)/2), round(graph_y+(graph_h-g.height)/2)), g)
    elif scene == "browser":
        # ffmpeg applies CVV mosaic before any aspect is composed.
        f = footage(round(t*FPS)+1)
        video_h = 914 if vertical else 526
        video_w = round(video_h*420/500)
        y = 592 if vertical else 371
        f = f.resize((video_w, video_h), Image.Resampling.LANCZOS)
        im.paste(f, (round((w-video_w)/2), y))
        d = ImageDraw.Draw(im)
        box(d, ((w-video_w)/2-2, y-2, (w+video_w)/2+2, y+video_h+2), None, LINE, 0)
    elif scene == "handoff":
        y = graph_y + graph_h/2
        box(d, (w*.15, y-90, w*.85, y+90), outline=CYAN)
        centered(d, y-48, "Adyen API declined", w, 34, AMBER)
        centered(d, y+12, "Open Stripe checkout", w, 42)
        packet(d, [(w*.25, y+134), (w*.75, y+134)], t)
    else:
        y = graph_y+80
        d.ellipse((w/2-63, y, w/2+63, y+126), fill="#20362C", outline=GREEN, width=3)
        points = [(w/2-28, y+63), (w/2-7, y+84), (w/2+33, y+40)]
        if t > .35:
            d.line(points, fill=GREEN, width=8, joint="curve")
        centered(d, y+158, "$19.99 · Stripe", w, 46)
        centered(d, y+236, "Watch the same flow live", w, 30, MUTED)
        centered(d, y+295, "soap-agentic-waterfall-demo.vercel.app", w, 23, CYAN, True)
    captions = {"intro": "One purchase, from API to API to browser.", "api": "Token to proxy to provider." if t < 4.4 else "Checkout.com declines. Next: Adyen’s API.", "adyen": "Request the sandbox refusal. Then continue to Stripe.", "handoff": "Continue through the checkout UI.", "browser": "Test card visible. Only the CVV is pixelated.", "result": "Two API steps. One browser. One result."}
    d = ImageDraw.Draw(im)
    centered(d, caption_y, captions[scene], w, 30, MUTED)
    centered(d, footer_y-37, "API animations + separately recorded Stripe sandbox take", w, 16, MUTED)
    d.line((margin, footer_y, w-margin, footer_y), fill=LINE, width=3)
    passed = sum(duration for name, duration in SCENES[:[s[0] for s in SCENES].index(scene)])+t
    d.line((margin, footer_y, margin+(w-margin*2)*passed/TOTAL, footer_y), fill=CYAN, width=4)
    return im

def run(args):
    subprocess.run([str(a) for a in args], check=True)

def prepare():
    WORK.mkdir(parents=True, exist_ok=True)
    if not SOURCE.exists():
        raise SystemExit(f"Missing local Browserbase recording: {SOURCE}")
    evidence = json.loads((ROOT / "out/vid-stripe2/attempts.json").read_text())
    assert evidence["attempts"][0]["verdict"]["outcome"] == "succeeded", "Require the verified clean Stripe take"
    frames = WORK / "stripe-cvv-frames"
    frames.mkdir(exist_ok=True)
    # Fingerprint source, mask and timing to avoid silently reusing an old edit.
    filters = "[0:v]split[b][r];[r]crop=177:40:958:274,scale=9:2,scale=177:40:flags=neighbor[p];[b][p]overlay=958:274,crop=420:500:750:8,setpts=(PTS-STARTPTS)/2.875,fps=30"
    digest = hashlib.sha256(SOURCE.read_bytes()).hexdigest()
    fingerprint = json.dumps([digest, filters, 4, 34.5, 360])
    manifest = frames / "source.json"
    if not manifest.exists() or manifest.read_text() != fingerprint or len(list(frames.glob("*.jpg"))) != 360:
        run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-ss", 4, "-t", 34.5, "-i", SOURCE, "-filter_complex", filters, "-frames:v", 360, "-q:v", 2, frames / "%04d.jpg"])
        manifest.write_text(fingerprint)
    (OUT / "evidence.json").write_text(json.dumps({"api": {"simulated": True, "declineClass": "issuer_unavailable", "providerCalls": 0}, "adyen": {"illustrated": True, "sandboxVerified": "2026-09-08", "resultCode": "Refused", "refusalReasonCode": "9", "testResponse": True, "providerCallsDuringRender": 0}, "browser": {"source": "vid-stripe2", "outcome": "succeeded", "separateTake": True, "sourceWindowSeconds": [4, 38.5], "speed": 2.875}, "durationSeconds": TOTAL, "mask": "CVV only"}, indent=2)+"\n")

def encode(aspect, name, duration):
    w, h = SIZES[aspect]
    target = WORK / f"{aspect}-{name}.mp4"
    args = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", FPS, "-i", "pipe:0", "-an", "-c:v", "libx264", "-preset", "fast", "-crf", 18, "-threads", 4, "-pix_fmt", "yuv420p", "-movflags", "+faststart", target]
    with subprocess.Popen([str(a) for a in args], stdin=subprocess.PIPE) as proc:
        try:
            for n in range(duration*FPS):
                proc.stdin.write(render(aspect, name, n/FPS).tobytes())
            proc.stdin.close()
            if proc.wait():
                raise RuntimeError(f"Encoding failed: {target}")
        except BaseException:
            proc.kill()
            raise
    print(f"Rendered {aspect}: {name} ({duration}s)", flush=True)
    return target

def storyboard(aspect):
    thumbs = []
    for name, duration in SCENES:
        im = render(aspect, name, duration*.78)
        im.save(WORK / f"preview-{aspect}-{name}.png")
        im.thumbnail((384, 540))
        thumbs.append(im)
    w, h = max(i.width for i in thumbs), max(i.height for i in thumbs)
    sheet = Image.new("RGB", (w*len(thumbs), h), BG)
    for index, im in enumerate(thumbs):
        sheet.paste(im, (index*w, 0))
    sheet.save(OUT / f"storyboard-{aspect}.jpg", quality=95)
    render(aspect, "intro", 1.5).save(OUT / f"cover-{aspect}.jpg", quality=95)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--aspect", choices=[*SIZES, "all"], default="all")
    parser.add_argument("--preview", action="store_true")
    parser.add_argument("--force", action="store_true", help="Compatibility flag; scene videos are always regenerated")
    args = parser.parse_args()
    prepare()
    for aspect in SIZES if args.aspect == "all" else [args.aspect]:
        storyboard(aspect)
        if args.preview:
            print(f"Previewed {aspect}", flush=True)
            continue
        target = OUT / f"reel-{aspect}.mp4"
        previous = OUT / "previous" / target.name
        if target.exists() and not previous.exists():
            previous.parent.mkdir(exist_ok=True)
            shutil.copy2(target, previous)
        clips = [encode(aspect, name, duration) for name, duration in SCENES]
        listing = WORK / f"{aspect}-concat.txt"
        listing.write_text("".join("file '"+str(p).replace("'", "'\\''")+"'\n" for p in clips))
        run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", 0, "-i", listing, "-c", "copy", "-movflags", "+faststart", target])
        print(f"Finished {target}: {TOTAL}s", flush=True)

if __name__ == "__main__":
    main()
